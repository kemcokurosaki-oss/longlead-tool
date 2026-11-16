// 長納期品 手配期限ツール：Supabase との読み書き（DB版の部品・黒崎管理）
//
// ■ しくみ
//   1. Microsoft でログインしたら、Supabase の longlead_docs から
//        base  … 品目・分類・機械別リストの元データ（森村さんの BASE）
//        state … 編集内容・設定・保存した案件（全員で共有）
//      を読み込み、ツール本体（index.html の <script type="text/plain" id="ll-app">）を起動する。
//   2. ツール本体の save() が呼ばれるたびに、共有する部分を少し待ってからまとめて保存する。
//      受注時リストの入力中の内容など（LOCAL_KEYS）は、今までどおりこのPCのブラウザにだけ保存する。
//   3. ほかの人が先に保存していた場合は、上書きせずに知らせて読み込み直す。
//
// ■ ツール本体（森村さんのコード）との約束
//   - ツール本体は BASE と S を今までどおり使う。BASE は window.__LL_BASE、S の初期値は load() が作る。
//   - save() の中身は LLDB.save(S) を呼ぶだけ。localStorage に直接保存しない。

(function () {
    'use strict';

    const S_URL = 'https://dgekjzkrybrswsxlcbvh.supabase.co';
    const S_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRnZWtqemtyeWJyc3dzeGxjYnZoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njg4ODQ3MjIsImV4cCI6MjA4NDQ2MDcyMn0.BsEj53lV3p76yE9fMPTaLn7ocKTNzYPTqIAnBafYItU';
    const APP_NAME = '長納期品 手配期限ツール';
    const LOCAL_KEY = 'longlead-db-local';
    const LOCAL_KEYS = ['order', 'curProject', 'lastExport']; // このPCだけに残すもの
    const SAVE_DELAY = 600; // ミリ秒。続けて編集したときはまとめて1回で保存する

    // localStorage が使えない環境（追跡防止など）でもログインできるようにする
    const memStore = {};
    const authStorage = {
        getItem: (k) => { try { return localStorage.getItem(k); } catch (e) { return memStore[k] ?? null; } },
        setItem: (k, v) => { try { localStorage.setItem(k, v); } catch (e) { memStore[k] = v; } },
        removeItem: (k) => { try { localStorage.removeItem(k); } catch (e) { delete memStore[k]; } }
    };
    const client = supabase.createClient(S_URL, S_KEY, {
        auth: { flowType: 'implicit', persistSession: true, detectSessionInUrl: true, autoRefreshToken: true, storage: authStorage }
    });

    let started = false;     // ツール本体を起動したか
    let isEditor = false;    // 保存できる人か
    let version = null;      // 読み込んだ state の版数（ほかの人の保存との食い違いを見分ける）
    let lastSaved = null;    // 最後に保存した内容（同じ内容なら保存しない）
    let pending = null;      // 保存待ちの内容
    let saving = false;
    let timer = null;

    // ===== 保存状況の表示（画面の左下） =====
    const STATUS_CSS = `
#ll_status { position: fixed; left: 10px; bottom: 10px; z-index: 2147481000; display: inline-flex; align-items: center; gap: 6px;
  padding: 4px 10px; border-radius: 14px; font-size: 12px; background: var(--panel, #fff); color: var(--muted, #5c6870);
  border: 1px solid var(--line, #c8d0d3); font-family: inherit; max-width: calc(100vw - 260px); }
#ll_status::before { content: ''; width: 8px; height: 8px; border-radius: 50%; background: currentColor; flex-shrink: 0; }
#ll_status[data-kind="ok"] { color: var(--ok, #2e7a4e); }
#ll_status[data-kind="saving"] { color: var(--muted, #5c6870); }
#ll_status[data-kind="view"] { color: var(--muted, #5c6870); }
#ll_status[data-kind="error"] { color: var(--danger, #b3321f); background: var(--dangerbg, #f7dcd5); }
#ll_status span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
@media print { #ll_status { display: none; } }`;

    function statusEl() {
        let el = document.getElementById('ll_status');
        if (!el) {
            const st = document.createElement('style');
            st.textContent = STATUS_CSS;
            document.head.appendChild(st);
            el = document.createElement('div');
            el.id = 'll_status';
            el.setAttribute('role', 'status');
            el.setAttribute('aria-live', 'polite');
            el.innerHTML = '<span></span>';
            document.body.appendChild(el);
        }
        return el;
    }
    function setStatus(kind, text) {
        const el = statusEl();
        el.dataset.kind = kind;
        el.querySelector('span').textContent = text;
        el.title = text;
    }

    // ===== 読み込み =====
    function readLocal() {
        try { return JSON.parse(localStorage.getItem(LOCAL_KEY) || '{}'); } catch (e) { return {}; }
    }
    function sharedPart(S) {
        const o = {};
        for (const k of Object.keys(S)) if (!LOCAL_KEYS.includes(k)) o[k] = S[k];
        return o;
    }
    function fmtDate(iso) {
        if (!iso) return '';
        const d = new Date(iso);
        const p = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    }

    async function checkEditor() {
        try {
            const { data, error } = await client.rpc('schedule_is_editor');
            if (error) return true; // 判定できないときは保存を試み、権限がなければ保存時に知らせる
            return !!data;
        } catch (e) { return true; }
    }

    async function boot() {
        setStatus('saving', 'データを読み込んでいます');
        try {
            const [res, editor] = await Promise.all([
                client.from('longlead_docs').select('id, data, version, updated_at, updated_by'),
                checkEditor()
            ]);
            if (res.error) throw new Error(res.error.message);
            const base = res.data.find((d) => d.id === 'base');
            const state = res.data.find((d) => d.id === 'state');
            if (!base) throw new Error('元データ（base）が登録されていません。管理者に連絡してください');

            isEditor = editor;
            version = state ? state.version : null;
            window.__LL_BASE = base.data;
            window.__LL_STATE = state ? state.data : {};
            window.__LL_LOCAL = readLocal();
            window.__LL_DATE = fmtDate(state ? state.updated_at : base.updated_at);
            lastSaved = JSON.stringify(window.__LL_STATE);

            // ツール本体を起動する（ふつうの <script> として実行するので、関数や変数は今までどおり全体から使える）
            const code = document.getElementById('ll-app').textContent;
            const sc = document.createElement('script');
            sc.textContent = code;
            document.body.appendChild(sc);

            if (!isEditor) setStatus('view', '閲覧のみ（変更は保存されません）');
            else if (pending === null && !saving) setStatus('ok', '最新の状態です');
        } catch (e) {
            started = false;
            setStatus('error', 'データを読み込めませんでした：' + (e.message || e));
        }
    }

    // ===== 保存 =====
    function save(S) {
        try {
            const loc = {};
            for (const k of LOCAL_KEYS) if (S[k] !== undefined) loc[k] = S[k];
            localStorage.setItem(LOCAL_KEY, JSON.stringify(loc));
        } catch (e) { /* このPCに残す分は保存できなくても動作は続ける */ }

        const body = JSON.stringify(sharedPart(S));
        if (body === lastSaved && pending === null) return;
        if (!isEditor) { setStatus('view', '閲覧のみ（変更は保存されません）'); return; }

        pending = body;
        setStatus('saving', '保存中');
        clearTimeout(timer);
        timer = setTimeout(flush, SAVE_DELAY);
    }

    async function flush() {
        if (saving || pending === null) return;
        const body = pending;
        pending = null;
        if (body === lastSaved) { setStatus('ok', '保存しました'); return; }
        saving = true;
        const { data, error } = await client.from('longlead_docs')
            .update({ data: JSON.parse(body) })
            .eq('id', 'state')
            .eq('version', version)
            .select('version');
        saving = false;

        if (error) {
            if (pending === null) pending = body;
            setStatus('error', '保存できませんでした（' + error.message + '）。編集を続けると再度保存します');
            return;
        }
        if (!data || data.length === 0) { await onNotSaved(); return; }

        version = data[0].version;
        lastSaved = body;
        if (pending !== null) flush();
        else setStatus('ok', '保存しました');
    }

    // 1行も更新されなかった：権限がないか、ほかの人が先に保存した
    async function onNotSaved() {
        const { data } = await client.from('longlead_docs').select('version, updated_by').eq('id', 'state').maybeSingle();
        if (data && data.version === version) {
            isEditor = false;
            pending = null;
            setStatus('view', '編集の権限がないため保存できません（閲覧のみ）');
            return;
        }
        pending = null;
        alert('ほかの人' + (data && data.updated_by ? '（' + data.updated_by + '）' : '') +
              'が先にデータを更新しました。\n最新の内容を読み込み直します。直前の変更は保存されていないので、もう一度行ってください。');
        location.reload();
    }

    // 保存が終わる前にページを閉じようとしたら確認する
    window.addEventListener('beforeunload', (e) => {
        if (pending !== null || saving) { e.preventDefault(); e.returnValue = ''; }
    });

    // ===== ログイン → 読み込み → 起動 =====
    M365Login.init(client, { appName: APP_NAME, floating: 'bottom-right', canEdit: () => isEditor });
    client.auth.onAuthStateChange((event, session) => {
        if (started || !session || !session.user) return;
        if (event !== 'INITIAL_SESSION' && event !== 'SIGNED_IN') return;
        started = true;
        setTimeout(boot, 0); // 認証の処理が終わってから読み込む
    });

    window.LLDB = { client, save, sharedPart, LOCAL_KEYS };
})();
