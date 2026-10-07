/**
 * `dsh-plugin-cohere` — browser half.
 *
 * The built-in Models page renders its full editor only for the two hand-written
 * provider families (`llm-deepseek`, `llm-pi-ai`); every other settings
 * namespace falls back to a "edit cordis.patch.yml" hint. Third-party adapters
 * supply their own card through the `settings.models.provider-card` seat, which
 * the page dispatches with `entryKey = settingsNs`.
 *
 * The card covers what the built-in editor would have: the API key (written
 * through the credentials service), the API node (`baseURL`), the model catalog
 * (fetch / adopt / per-row edit), the JSON-mode and citation switches, and one
 * button that admits this provider's routes into the subagent model allowlist.
 *
 * Loaded through the shell's `window.__ModuleLoader__` seam, so this stays a
 * plain factory with `require("react")` — no bundler.
 *
 * @module dsh-plugin-cohere/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-plugin-cohere',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const React = require('react');
    const h = React.createElement;

    /** Provider route this card configures. */
    const PROVIDER = 'cohere';
    /** Settings namespace the host half registers under. */
    const DEFAULT_NS = 'llm-cohere';
    /** Credential reference used when the view names none. */
    const DEFAULT_REF = 'COHERE_API_KEY';
    /** Shipped chat endpoint, shown as the node placeholder. */
    const DEFAULT_BASE_URL = 'https://api.cohere.com/v2';

    /** Reference the page derives for a route: `<ROUTE>_API_KEY`. */
    const deriveKeyRef = (provider) =>
      `${String(provider).toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`;

    /** Resolve the credential reference for one provider view. */
    const refOf = (provider) => {
      if (provider && typeof provider.apiKeyEnv === 'string' && provider.apiKeyEnv.length > 0) {
        return provider.apiKeyEnv;
      }
      if (provider && typeof provider.provider === 'string' && provider.provider.length > 0) {
        return deriveKeyRef(provider.provider);
      }
      return DEFAULT_REF;
    };

    /** Resolve the settings namespace the host registered under. */
    const nsOf = (provider) =>
      provider && typeof provider.settingsNs === 'string' && provider.settingsNs.length > 0
        ? provider.settingsNs
        : DEFAULT_NS;

    /** Shorten a value for on-screen diagnostics. */
    const short = (value) => {
      let text;
      try {
        text = JSON.stringify(value);
      } catch {
        text = String(value);
      }
      if (text === undefined) text = String(value);
      return text.length > 500 ? `${text.slice(0, 500)}…` : text;
    };

    /** Read a remote reply, returning undefined on success or the message on failure. */
    const replyFailure = (reply) => {
      if (reply && reply.ok === true) return undefined;
      const error = reply && reply.error;
      return (error && (error.message || String(error))) || '请求失败';
    };

    /** Numeric field value, or a fallback for a blank/invalid entry. */
    const asNumber = (text, fallback) => {
      const value = Number(String(text).trim());
      return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
    };

    /** Normalise one edited row onto the plugin's configured model shape. */
    const toRow = (row) => ({
      id: String(row.id).trim(),
      name: String(row.name ?? '').trim() || String(row.id).trim(),
      description: '',
      contextWindow: asNumber(row.contextWindow, 128000),
      maxTokens: asNumber(row.maxTokens, 8192),
      inputModalities: row.image === true ? ['text', 'image'] : ['text'],
      reasoning: row.reasoning === true,
      // Per-route request features from the live Cohere `features` list; the
      // host defaults every absent flag to `true`, so an unknown source keeps
      // the modern behaviour and the adapter's retry net covers a wrong guess.
      tools: row.tools !== false,
      citations: row.citations !== false,
      strictTools: row.strictTools !== false,
      deprecated: false,
    });

    /** Map one discovered model onto the editable row shape. */
    const fromDiscovered = (model) => ({
      id: String(model.id),
      name: typeof model.name === 'string' && model.name.length > 0 ? model.name : String(model.id),
      contextWindow: typeof model.contextWindow === 'number' ? model.contextWindow : 128000,
      maxTokens: 8192,
      image: Array.isArray(model.inputModalities) && model.inputModalities.includes('image'),
      reasoning: false,
      // The discovery response carries no `features`, so these stay undefined
      // and `toRow` writes the capable defaults.
      tools: undefined,
      citations: undefined,
      strictTools: undefined,
    });

    /** Map one effective catalog entry onto the editable row shape. */
    const fromCatalogModel = (model) => {
      const context =
        typeof model.contextWindow === 'number'
          ? model.contextWindow
          : model.context && typeof model.context.contextWindow === 'number'
            ? model.context.contextWindow
            : undefined;
      const maxTokens =
        typeof model.maxTokens === 'number'
          ? model.maxTokens
          : typeof model.defaultMaxTokens === 'number'
            ? model.defaultMaxTokens
            : undefined;
      const modalities = Array.isArray(model.inputModalities)
        ? model.inputModalities
        : Array.isArray(model.input)
          ? model.input
          : [];
      return {
        id: String(model.id ?? ''),
        name: String(model.name ?? model.id ?? ''),
        contextWindow: context,
        maxTokens,
        image: modalities.includes('image'),
        reasoning:
          model.reasoning !== undefined && model.reasoning !== false && model.reasoning !== null,
        tools: model.tools,
        citations: model.citations,
        strictTools: model.strictTools,
      };
    };

    /** Map one saved settings model onto the editable row shape. */
    const fromSavedModel = (model) => ({
      id: String(model.id ?? ''),
      name: String(model.name ?? ''),
      contextWindow: typeof model.contextWindow === 'number' ? model.contextWindow : undefined,
      maxTokens: typeof model.maxTokens === 'number' ? model.maxTokens : undefined,
      image: Array.isArray(model.inputModalities) && model.inputModalities.includes('image'),
      reasoning: model.reasoning === true,
      tools: model.tools,
      citations: model.citations,
      strictTools: model.strictTools,
    });

    const labelStyle = { fontSize: '12px', lineHeight: '1.5' };
    const mutedStyle = { ...labelStyle, color: 'var(--dsw-alias-label-secondary, #9a9a9a)' };
    const monoStyle = {
      ...labelStyle,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-all',
      color: 'var(--dsw-alias-label-secondary, #9a9a9a)',
    };
    const inputStyle = {
      flex: '1 1 240px',
      minWidth: '160px',
      padding: '6px 8px',
      borderRadius: '6px',
      border: '1px solid var(--dsw-alias-border-secondary, #3a3a3a)',
      background: 'var(--dsw-alias-bg-secondary, transparent)',
      color: 'inherit',
    };
    const cellStyle = { ...inputStyle, minWidth: '0', width: '100%', padding: '4px 6px' };
    const buttonStyle = {
      padding: '6px 12px',
      borderRadius: '6px',
      border: '1px solid var(--dsw-alias-border-secondary, #3a3a3a)',
      background: 'var(--dsw-alias-bg-secondary, transparent)',
      color: 'inherit',
      cursor: 'pointer',
    };
    const smallButtonStyle = { ...buttonStyle, padding: '3px 8px', fontSize: '12px' };
    const rowStyle = { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' };
    /** One shared column template keeps the header and every row aligned. */
    const modelGrid = 'minmax(120px, 1.6fr) minmax(110px, 1.4fr) 76px 76px 44px 44px 60px';
    const tableRowStyle = {
      display: 'grid',
      gridTemplateColumns: modelGrid,
      gap: '6px',
      alignItems: 'center',
      marginBottom: '4px',
    };

    /**
     * The Cohere provider card.
     * @param props - owner props (`provider`, `configured`, `keyConfigured`) plus `ctx`.
     * @returns the card element.
     */
    function CohereCard(props) {
      const ctx = props.ctx;
      const provider = props.provider;
      const ref = refOf(provider);
      const ns = nsOf(provider);

      const [keyDraft, setKeyDraft] = React.useState('');
      const [nodeDraft, setNodeDraft] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const [notice, setNotice] = React.useState(undefined);
      const [models, setModels] = React.useState(undefined);
      const [rows, setRows] = React.useState(undefined);
      const [flags, setFlags] = React.useState({ jsonMode: false, includeCitations: false });
      const [diag, setDiag] = React.useState([]);

      const pushDiag = (line) => setDiag((prev) => [...prev.slice(-8), line]);

      /** Fetch the live settings document for one namespace. */
      const readNamespace = async (namespace) => {
        const face = ctx && ctx.remote && ctx.remote.settings;
        if (!face || typeof face.describe !== 'function') return undefined;
        const reply = await face.describe();
        if (replyFailure(reply) !== undefined) return undefined;
        const list = Array.isArray(reply.value) ? reply.value : [];
        const entry = list.find((item) => item && item.ns === namespace);
        return entry && entry.value && typeof entry.value === 'object' ? entry.value : {};
      };

      /** Read the effective model catalog (saved override or shipped defaults). */
      const readCatalog = async () => {
        const sessionFace = ctx && ctx.remote && ctx.remote.session;
        if (sessionFace && typeof sessionFace.modelCatalog === 'function') {
          const reply = await sessionFace.modelCatalog();
          if (replyFailure(reply) === undefined) {
            const groups = (reply.value && reply.value.groups) || [];
            const group = groups.find((entry) => entry && entry.id === PROVIDER);
            if (group && Array.isArray(group.models)) return group.models.map(fromCatalogModel);
          } else {
            pushDiag(`modelCatalog -> ${short(reply)}`);
          }
        }
        const llmFace = ctx && ctx.remote && ctx.remote.llm;
        if (llmFace && typeof llmFace.listModels === 'function') {
          const reply = await llmFace.listModels(PROVIDER);
          if (replyFailure(reply) === undefined && Array.isArray(reply.value)) {
            return reply.value.map(fromCatalogModel);
          }
        }
        return undefined;
      };

      // Seed the toggles, node and model table from the live values.
      React.useEffect(() => {
        let alive = true;
        (async () => {
          try {
            const value = await readNamespace(ns);
            if (!alive) return;
            if (value !== undefined) {
              setFlags({
                jsonMode: value.jsonMode === true,
                includeCitations: value.includeCitations === true,
              });
              if (typeof value.baseURL === 'string' && value.baseURL.length > 0) {
                setNodeDraft(value.baseURL);
              }
              if (Array.isArray(value.models)) {
                setRows(value.models.map(fromSavedModel));
                return;
              }
            }
            // No override is saved, so show the effective catalog straight away —
            // the table must never wait for a manual "fetch", matching how the
            // built-in provider cards present their installed models.
            const seeded = await readCatalog();
            if (alive && Array.isArray(seeded)) setRows(seeded);
          } catch (error) {
            pushDiag(`seed failed: ${String((error && error.message) || error)}`);
          }
        })();
        return () => {
          alive = false;
        };
      }, []);

      const run = async (job) => {
        if (busy) return;
        setBusy(true);
        setNotice(undefined);
        try {
          await job();
        } catch (error) {
          const text = String((error && error.message) || error);
          setNotice({ tone: 'error', text });
          pushDiag(`throw: ${text}`);
        } finally {
          setBusy(false);
        }
      };

      /** Write one settings op list into a namespace. */
      const writeSettings = async (namespace, ops) => {
        const face = ctx && ctx.remote && ctx.remote.settings;
        if (!face || typeof face.mutate !== 'function') {
          pushDiag('remote.settings unavailable');
          return 'ctx.remote.settings 不可用';
        }
        const reply = await face.mutate(namespace, ops, undefined);
        pushDiag(`mutate ${namespace} ${short(ops)} -> ${short(reply)}`);
        return replyFailure(reply);
      };

      const saveKey = () =>
        run(async () => {
          const value = keyDraft.trim();
          if (value.length === 0) {
            setNotice({ tone: 'error', text: '请输入 API Key' });
            return;
          }
          const face = ctx && ctx.remote && ctx.remote.credentials;
          if (!face || typeof face.set !== 'function') {
            setNotice({ tone: 'error', text: 'ctx.remote.credentials 不可用' });
            return;
          }
          const reply = await face.set(ref, value);
          pushDiag(`credentials.set(${ref}) -> ${short(reply)}`);
          const failure = replyFailure(reply);
          if (failure !== undefined) {
            setNotice({ tone: 'error', text: failure });
            return;
          }
          setKeyDraft('');
          setNotice({ tone: 'ok', text: `已写入凭据服务（${ref}）` });
        });

      const saveNode = () =>
        run(async () => {
          const value = nodeDraft.trim();
          const failure =
            value.length === 0
              ? await writeSettings(ns, [{ op: 'unset', path: ['baseURL'] }])
              : await writeSettings(ns, [{ op: 'set', path: ['baseURL'], value }]);
          if (failure !== undefined) {
            setNotice({ tone: 'error', text: failure });
            return;
          }
          setNotice({
            tone: 'ok',
            text: value.length === 0 ? 'API 节点已恢复默认' : `API 节点已保存：${value}`,
          });
        });

      const fetchModels = () =>
        run(async () => {
          const face = ctx && ctx.remote && ctx.remote.llm;
          if (!face || typeof face.discoverModels !== 'function') {
            setNotice({ tone: 'error', text: 'ctx.remote.llm 不可用' });
            return;
          }
          const reply = await face.discoverModels(ns, { provider: PROVIDER });
          pushDiag(`discover(${ns}) -> ${short(reply)}`);
          const failure = replyFailure(reply);
          if (failure !== undefined) {
            setNotice({ tone: 'error', text: failure });
            return;
          }
          const list = Array.isArray(reply.value) ? reply.value : [];
          setModels(list);
          setRows(list.map(fromDiscovered));
          setNotice({ tone: 'ok', text: `接口返回 ${list.length} 个模型（已填入表格）` });
        });

      const setRow = (index, patch) =>
        setRows((prev) => {
          const next = [...(prev ?? [])];
          next[index] = { ...(next[index] ?? { id: '' }), ...patch };
          return next;
        });

      const addRow = () => setRows((prev) => [...(prev ?? []), { id: '', name: '' }]);
      const removeRow = (index) =>
        setRows((prev) => (prev ?? []).filter((_, position) => position !== index));

      const saveModels = () =>
        run(async () => {
          const cleaned = (rows ?? []).filter((row) => String(row.id ?? '').trim().length > 0);
          if (cleaned.length === 0) {
            setNotice({ tone: 'error', text: '至少要有 1 个带 id 的模型行' });
            return;
          }
          const failure = await writeSettings(ns, [
            { op: 'set', path: ['models'], value: cleaned.map(toRow) },
          ]);
          if (failure !== undefined) {
            setNotice({ tone: 'error', text: failure });
            return;
          }
          setNotice({ tone: 'ok', text: `已保存 ${cleaned.length} 个模型` });
        });

      const resetModels = () =>
        run(async () => {
          const failure = await writeSettings(ns, [{ op: 'unset', path: ['models'] }]);
          if (failure !== undefined) {
            setNotice({ tone: 'error', text: failure });
            return;
          }
          setRows(undefined);
          setModels(undefined);
          setNotice({ tone: 'ok', text: '模型目录已恢复内置默认' });
        });

      const setFlag = (key, value) =>
        run(async () => {
          const failure = await writeSettings(ns, [{ op: 'set', path: [key], value }]);
          if (failure !== undefined) {
            setNotice({ tone: 'error', text: failure });
            return;
          }
          setFlags((prev) => ({ ...prev, [key]: value }));
          setNotice({ tone: 'ok', text: `${key} = ${String(value)}` });
        });

      const configured = props.keyConfigured === true;

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '10px', padding: '8px 0' } },
        h(
          'div',
          { style: rowStyle },
          h('input', {
            type: 'password',
            value: keyDraft,
            disabled: busy,
            placeholder: configured ? '已配置，输入新 Key 可覆盖' : 'Cohere API Key',
            'aria-label': 'Cohere API Key',
            autoComplete: 'new-password',
            onChange: (event) => setKeyDraft(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') saveKey();
            },
            style: inputStyle,
          }),
          h(
            'button',
            { type: 'button', disabled: busy, onClick: saveKey, style: buttonStyle },
            '保存 Key',
          ),
          h('span', { style: mutedStyle }, configured ? '凭据：已配置' : '凭据：未配置'),
        ),
        h(
          'div',
          { style: rowStyle },
          h('input', {
            type: 'text',
            value: nodeDraft,
            disabled: busy,
            placeholder: `API 节点（留空=默认 ${DEFAULT_BASE_URL}）`,
            'aria-label': 'Cohere API 节点',
            onChange: (event) => setNodeDraft(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') saveNode();
            },
            style: inputStyle,
          }),
          h(
            'button',
            { type: 'button', disabled: busy, onClick: saveNode, style: buttonStyle },
            '保存节点',
          ),
        ),
        h(
          'div',
          { style: rowStyle },
          h(
            'button',
            { type: 'button', disabled: busy, onClick: fetchModels, style: buttonStyle },
            '从端点刷新模型',
          ),
          h(
            'button',
            { type: 'button', disabled: busy, onClick: addRow, style: buttonStyle },
            '添加模型行',
          ),
          h(
            'button',
            { type: 'button', disabled: busy, onClick: saveModels, style: buttonStyle },
            '保存模型',
          ),
          h(
            'button',
            { type: 'button', disabled: busy, onClick: resetModels, style: buttonStyle },
            '恢复默认目录',
          ),
        ),
        h(
          'div',
          { style: rowStyle },
          h(
            'label',
            { style: labelStyle },
            h('input', {
              type: 'checkbox',
              checked: flags.jsonMode,
              disabled: busy,
              onChange: (event) => setFlag('jsonMode', event.target.checked),
            }),
            ' JSON 模式（response_format）',
          ),
          h(
            'label',
            { style: labelStyle },
            h('input', {
              type: 'checkbox',
              checked: flags.includeCitations,
              disabled: busy,
              onChange: (event) => setFlag('includeCitations', event.target.checked),
            }),
            ' 启用引用（Citations 脚注）',
          ),
        ),
        h('div', { style: mutedStyle }, `ref=${ref} · ns=${ns}`),
        notice !== undefined
          ? h(
              'div',
              {
                style: {
                  ...labelStyle,
                  fontWeight: '600',
                  color:
                    notice.tone === 'error' ? '#e5484d' : 'var(--dsw-alias-label-secondary, #9a9a9a)',
                },
              },
              notice.text,
            )
          : null,
        Array.isArray(rows) && rows.length > 0
          ? h(
              'div',
              { style: { ...labelStyle, maxHeight: '260px', overflow: 'auto' } },
              h(
                'div',
                { style: { ...tableRowStyle, ...mutedStyle } },
                h('span', null, 'id'),
                h('span', null, '名称'),
                h('span', null, '上下文'),
                h('span', null, '最大输出'),
                h('span', { style: { textAlign: 'center' } }, '图片'),
                h('span', { style: { textAlign: 'center' } }, '推理'),
                h('span', null, ''),
              ),
              rows.map((row, index) =>
                h(
                  'div',
                  { style: tableRowStyle, key: `${index}-${String(row.id)}` },
                  h('input', {
                    type: 'text',
                    value: row.id ?? '',
                    disabled: busy,
                    'aria-label': 'model id',
                    onChange: (event) => setRow(index, { id: event.target.value }),
                    style: cellStyle,
                  }),
                  h('input', {
                    type: 'text',
                    value: row.name ?? '',
                    disabled: busy,
                    'aria-label': 'model name',
                    onChange: (event) => setRow(index, { name: event.target.value }),
                    style: cellStyle,
                  }),
                  h('input', {
                    type: 'number',
                    value: row.contextWindow ?? '',
                    disabled: busy,
                    'aria-label': 'context window',
                    onChange: (event) => setRow(index, { contextWindow: event.target.value }),
                    style: cellStyle,
                  }),
                  h('input', {
                    type: 'number',
                    value: row.maxTokens ?? '',
                    disabled: busy,
                    'aria-label': 'max output tokens',
                    onChange: (event) => setRow(index, { maxTokens: event.target.value }),
                    style: cellStyle,
                  }),
                  h('input', {
                    type: 'checkbox',
                    checked: row.image === true,
                    disabled: busy,
                    'aria-label': 'image input',
                    onChange: (event) => setRow(index, { image: event.target.checked }),
                  }),
                  h('input', {
                    type: 'checkbox',
                    checked: row.reasoning === true,
                    disabled: busy,
                    'aria-label': 'reasoning',
                    onChange: (event) => setRow(index, { reasoning: event.target.checked }),
                  }),
                  h(
                    'button',
                    {
                      type: 'button',
                      disabled: busy,
                      onClick: () => removeRow(index),
                      style: smallButtonStyle,
                    },
                    '删除',
                  ),
                ),
              ),
            )
          : Array.isArray(models) && models.length > 0
            ? h(
                'div',
                { style: { ...labelStyle, maxHeight: '180px', overflow: 'auto' } },
                models.map((model) =>
                  h(
                    'div',
                    { key: String(model.id) },
                    String(model.id) +
                      (typeof model.name === 'string' && model.name !== model.id
                        ? `  —  ${model.name}`
                        : ''),
                  ),
                ),
              )
            : null,
        diag.length > 0
          ? h(
              'details',
              { style: labelStyle },
              h('summary', { style: mutedStyle }, '诊断'),
              h('div', { style: monoStyle }, diag.map((line, index) => h('div', { key: index }, line))),
            )
          : null,
      );
    }

    /** Required client services (fiber inject waiting). */
    const inject = ['slots', 'remote', 'remote.credentials', 'remote.llm', 'remote.settings'];

    /**
     * Mount the Cohere provider card on every card of its namespace.
     * @param ctx - client root context.
     */
    function apply(ctx) {
      for (const key of ['llm-cohere', 'include:llm-cohere']) {
        try {
          ctx.slots.inject('settings.models.provider-card', () =>
            ctx.slots.register(
              {
                name: 'settings.models.provider-card',
                key,
                inject: () => ({ ctx }),
              },
              CohereCard,
            ),
          );
        } catch (error) {
          console.warn('[dsh-plugin-cohere] provider card registration failed:', error);
        }
      }
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
