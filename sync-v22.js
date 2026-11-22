/*
 * BENEDITA STUDIO 3D — sincronização experimental v2.2 (2026-11)
 * Anexo não destrutivo para Central v2.1.
 * Funciona depois de configurar Supabase + SQL + conta autenticada.
 * Não sincroniza arquivos externos ao PWA nem o antigo Calc Android separado.
 */
(() => {
  'use strict';
  const DB_NAME = 'benedita_studio_3d_catalog_v1';
  const DB_VERSION = 9;
  const STORES = [
    'products', 'filament_spools', 'filament_movements', 'orders',
    'calc_quotes', 'finance_entries', 'creation_projects', 'clients',
    'tax_documents', 'sku_product_records'
  ];
  const SETTINGS = [
    'benedita_central_calc_url', 'benedita_central_print_contacts_v19',
    'benedita_central_tax_portal_v20'
  ];
  const META_DB = 'benedita_sync_meta_v22';
  const META_STORE = 'snapshots';
  const SESSION_KEY = 'benedita_sync_session_v22';
  const BUCKET = 'benedita-arquivos';
  const POLL_MS = 60000;
  const cfg = window.BENEDITA_SYNC_CONFIG || {};
  const rootUrl = String(cfg.supabaseUrl || '').trim().replace(/\/+$/, '');
  const publicKey = String(cfg.publishableKey || '').trim();
  const configured = /^https:\/\/[\w.-]+\.supabase\.co$/i.test(rootUrl) &&
    !/COLE_AQUI/i.test(publicKey) && publicKey.length > 20;
  let session = readSession();
  let syncing = false;
  let lastError = '';
  let lastConflicts = [];
  let updatedCount = 0;
  let ui = {};

  function readSession() {
    try {
      const v = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
      return v && typeof v.access_token === 'string' && typeof v.refresh_token === 'string' &&
        typeof v.user_id === 'string' ? v : null;
    } catch { return null; }
  }
  function saveSession(v) {
    session = v;
    if (v) localStorage.setItem(SESSION_KEY, JSON.stringify(v));
    else localStorage.removeItem(SESSION_KEY);
  }
  function shortError(e) {
    const msg = String(e?.message || e || 'Erro desconhecido');
    return msg.length > 250 ? msg.slice(0, 247) + '...' : msg;
  }
  function status(message, kind = 'idle') {
    if (ui.status) ui.status.textContent = message;
    if (ui.button) {
      ui.button.textContent = kind === 'busy' ? '☁ Sincronizando…' :
        kind === 'ok' ? '☁ Sincronizado' : kind === 'error' ? '☁ Atenção' : '☁ Sincronização';
      ui.button.dataset.kind = kind;
    }
  }
  function apiHeaders(token, contentType = 'application/json') {
    const h = { apikey: publicKey };
    if (token) h.Authorization = `Bearer ${token}`;
    if (contentType) h['Content-Type'] = contentType;
    return h;
  }
  async function rawRequest(path, options = {}, needsAuth = true, retry = true, rawResponse = false) {
    if (!configured) throw Error('Falta configurar o projeto Supabase.');
    if (!navigator.onLine) throw Error('Sem internet. Alterações permanecem neste aparelho.');
    if (needsAuth) await ensureSession();
    const h = { ...apiHeaders(needsAuth ? session.access_token : null,
      options.body instanceof Blob ? options.body.type || 'application/octet-stream' :
      options.body == null ? null : 'application/json'), ...(options.headers || {}) };
    const res = await fetch(rootUrl + path, { ...options, headers: h });
    if (res.status === 401 && needsAuth && retry && session) {
      await refreshSession(true);
      return rawRequest(path, options, true, false, rawResponse);
    }
    if (!res.ok) {
      let reason = `HTTP ${res.status}`;
      try { const obj = await res.json(); reason = obj.message || obj.error_description || obj.msg || obj.error || reason; } catch {}
      throw Error(reason);
    }
    if (res.status === 204) return null;
    if (rawResponse) return res;
    const type = res.headers.get('content-type') || '';
    return type.includes('application/json') ? res.json() : res;
  }
  async function refreshSession(force = false) {
    if (!session) throw Error('Entre na sua conta para sincronizar.');
    if (!force && session.expires_at && Date.now() < session.expires_at - 90000) return;
    if (!navigator.onLine) throw Error('Aguardando internet para renovar a sessão.');
    const res = await fetch(rootUrl + '/auth/v1/token?grant_type=refresh_token', {
      method: 'POST', headers: apiHeaders(null),
      body: JSON.stringify({ refresh_token: session.refresh_token })
    });
    if (!res.ok) { saveSession(null); throw Error('Sessão expirada. Faça login novamente.'); }
    const data = await res.json();
    saveSession({ access_token: data.access_token, refresh_token: data.refresh_token,
      user_id: data.user?.id || session.user_id,
      expires_at: Date.now() + (Number(data.expires_in || 3600) * 1000) });
  }
  async function ensureSession() {
    if (!session) throw Error('Entre na sua conta para sincronizar.');
    await refreshSession();
  }
  async function login(email, password) {
    if (!configured) throw Error('O projeto Supabase ainda não foi configurado.');
    const res = await fetch(rootUrl + '/auth/v1/token?grant_type=password', {
      method: 'POST', headers: apiHeaders(null),
      body: JSON.stringify({ email, password })
    });
    let data = {};
    try { data = await res.json(); } catch {}
    if (!res.ok || !data.access_token || !data.user?.id) {
      throw Error(data.msg || data.error_description || data.message || 'Não foi possível entrar. Confira seu e-mail e senha.');
    }
    saveSession({ access_token: data.access_token, refresh_token: data.refresh_token,
      user_id: data.user.id,
      expires_at: Date.now() + Number(data.expires_in || 3600) * 1000 });
    lastError = ''; lastConflicts = [];
    showSession();
    await syncNow();
  }

  // IndexedDB atual da Central; não muda sua versão/esquema.
  function openDb(name, version, upgrading) {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(name, version);
      if (upgrading) req.onupgradeneeded = () => upgrading(req.result, req.transaction);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || Error('Não foi possível abrir o banco local.'));
      req.onblocked = () => reject(Error('Feche outras abas da Central e tente novamente.'));
    });
  }
  async function appDB() {
    const db = await openDb(DB_NAME, DB_VERSION, (base, tx) => {
      for (const name of STORES) if (!base.objectStoreNames.contains(name))
        base.createObjectStore(name, { keyPath: 'id' });
      // Índice mantido igual ao usado na Central original.
      const t = tx.objectStore('filament_movements');
      if (!t.indexNames.contains('spoolId')) t.createIndex('spoolId', 'spoolId', { unique: false });
    });
    for (const name of STORES) if (!db.objectStoreNames.contains(name)) {
      db.close(); throw Error(`Banco local incompleto: ${name}`);
    }
    return db;
  }
  async function metaDB() {
    return openDb(META_DB, 1, db => {
      if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE, { keyPath: 'key' });
    });
  }
  function storeAction(db, name, mode, fn) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(name, mode);
      const store = tx.objectStore(name);
      let result;
      let req;
      try { req = fn(store); } catch (e) { reject(e); return; }
      if (req) req.onsuccess = () => { result = req.result; };
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error || Error('Erro no armazenamento local.'));
      tx.onabort = () => reject(tx.error || Error('Operação local cancelada.'));
    });
  }
  async function localData(db) {
    const out = new Map();
    for (const name of STORES) {
      const list = await storeAction(db, name, 'readonly', st => st.getAll());
      for (const record of list) out.set(keyOf(name, String(record.id)), { store: name, id: String(record.id), data: record });
    }
    const settings = { id: 'global' };
    for (const key of SETTINGS) settings[key] = localStorage.getItem(key) || null;
    out.set(keyOf('__settings', 'global'), { store: '__settings', id: 'global', data: settings });
    return out;
  }
  function keyOf(store, id) { return store + '\u0000' + id; }
  async function localRecord(db, store, id) {
    if (store === '__settings') {
      const v = { id: 'global' };
      for (const key of SETTINGS) v[key] = localStorage.getItem(key) || null;
      return v;
    }
    return storeAction(db, store, 'readonly', st => st.get(id));
  }
  async function putLocal(db, store, id, value) {
    if (store === '__settings') {
      for (const key of SETTINGS) {
        if (typeof value[key] === 'string') localStorage.setItem(key, value[key]);
        else localStorage.removeItem(key);
      }
    } else {
      if (String(value.id) !== id) throw Error('Registro remoto com identificação divergente.');
      await storeAction(db, store, 'readwrite', st => st.put(value));
    }
  }
  async function deleteLocal(db, store, id) {
    if (store === '__settings') {
      for (const key of SETTINGS) localStorage.removeItem(key);
    } else await storeAction(db, store, 'readwrite', st => st.delete(id));
  }
  async function snapshots(db) {
    const out = new Map();
    for (const row of await storeAction(db, META_STORE, 'readonly', st => st.getAll()))
      if (row.key !== '__account') out.set(row.key, row);
    return out;
  }
  async function saveSnapshot(db, store, id, hash, revision, deleted = false) {
    const v = { key: keyOf(store, id), hash, revision: Number(revision), deleted };
    await storeAction(db, META_STORE, 'readwrite', st => st.put(v));
  }
  // A assinatura considera conteúdo JSON, datas de edição e metadados dos Blobs.
  // Projetos da Central atualizam updatedAt ao alterar seus arquivos.
  function normalized(value) {
    if (value instanceof Blob) return { _beneditaBlob: true, size: value.size, type: value.type,
      modified: Number(value.lastModified || 0) };
    if (Array.isArray(value)) return value.map(normalized);
    if (value && typeof value === 'object') {
      const o = {};
      for (const key of Object.keys(value).sort()) o[key] = normalized(value[key]);
      return o;
    }
    return value;
  }
  async function binaryDigest(bytes) {
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(hash), n => n.toString(16).padStart(2, '0')).join('');
  }
  async function digest(text) {
    return binaryDigest(new TextEncoder().encode(text));
  }
  async function fingerprint(data) { return digest(JSON.stringify(normalized(data))); }
  async function storagePath(store, id, path, blob) {
    const identity = await digest(store + '\n' + id + '\n' + path);
    // Caminhos imutaveis por CONTEUDO: um conflito de versoes nunca
    // substitui silenciosamente o arquivo referenciado pela versao anterior.
    const contentHash = await binaryDigest(await blob.arrayBuffer());
    return `${session.user_id}/${store}/${identity}/${contentHash}`;
  }
  async function uploadBlob(blob, store, id, path) {
    const name = await storagePath(store, id, path, blob);
    const res = await rawRequest('/storage/v1/object/' + BUCKET + '/' + name, {
      method: 'POST', headers: { 'x-upsert': 'true', 'Content-Type': blob.type || 'application/octet-stream' },
      body: blob
    });
    if (!res) throw Error('Falhou o envio de um arquivo.');
    return name;
  }
  async function downloadBlob(path, mime) {
    if (typeof path !== 'string' || !path.startsWith(session.user_id + '/'))
      throw Error('Caminho de arquivo remoto inválido.');
    const res = await rawRequest('/storage/v1/object/authenticated/' + BUCKET + '/' + path,
      { method: 'GET' }, true, true, true);
    const bytes = await res.arrayBuffer();
    return new Blob([bytes], { type: mime || 'application/octet-stream' });
  }
  function isLargeDataImage(v) { return typeof v === 'string' && v.startsWith('data:image/') && v.length > 180000; }
  function dataUrlToBlob(url) {
    const match = /^data:(image\/[\w.+-]+);base64,(.*)$/s.exec(url);
    if (!match) throw Error('Formato de foto inválido para sincronização.');
    const decoded = atob(match[2]);
    const bytes = new Uint8Array(decoded.length);
    for (let i = 0; i < bytes.length; i++) bytes[i] = decoded.charCodeAt(i);
    return new Blob([bytes], { type: match[1] });
  }
  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || Error('Não foi possível ler foto.'));
      reader.readAsDataURL(blob);
    });
  }
  async function encode(value, store, id, path = 'record') {
    if (value instanceof Blob) {
      return { __beneditaSyncFile: 1,
        key: await uploadBlob(value, store, id, path),
        mime: value.type || 'application/octet-stream' };
    }
    if (isLargeDataImage(value)) {
      const blob = dataUrlToBlob(value);
      return { __beneditaSyncImage: 1,
        key: await uploadBlob(blob, store, id, path), mime: blob.type };
    }
    if (Array.isArray(value)) {
      const out = [];
      for (let i = 0; i < value.length; i++) out.push(await encode(value[i], store, id, path + '/' + i));
      return out;
    }
    if (value && typeof value === 'object') {
      const out = {};
      for (const [key, item] of Object.entries(value)) out[key] = await encode(item, store, id, path + '/' + key);
      return out;
    }
    return value;
  }
  async function decode(value) {
    if (value && typeof value === 'object' && value.__beneditaSyncFile === 1) {
      return downloadBlob(value.key, value.mime);
    }
    if (value && typeof value === 'object' && value.__beneditaSyncImage === 1) {
      return blobToDataUrl(await downloadBlob(value.key, value.mime));
    }
    if (Array.isArray(value)) {
      const out = [];
      for (const x of value) out.push(await decode(x));
      return out;
    }
    if (value && typeof value === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(value)) out[k] = await decode(v);
      return out;
    }
    return value;
  }
  async function remoteRows() {
    const map = new Map();
    const pageSize = 500;
    for (let offset = 0; offset < 100000; offset += pageSize) {
      const qs = '?select=store,record_id,payload,fingerprint,revision,deleted_at&order=revision.asc'
        + `&limit=${pageSize}&offset=${offset}`;
      const list = await rawRequest('/rest/v1/benedita_sync_records' + qs);
      if (!Array.isArray(list)) throw Error('Resposta inválida do banco na nuvem.');
      for (const item of list) map.set(keyOf(item.store, item.record_id), item);
      if (list.length < pageSize) return map;
    }
    throw Error('Limite de registros excedido.');
  }
  async function cloudWrite(store, id, data, hash, deleted, expected) {
    const payload = deleted ? null : await encode(data, store, id);
    return rawRequest('/rest/v1/rpc/benedita_sync_write', {
      method: 'POST', body: JSON.stringify({
        p_store: store, p_record_id: id, p_payload: payload,
        p_fingerprint: hash || 'DELETED', p_deleted: deleted,
        p_expected_revision: expected
      })
    });
  }
  async function syncNow() {
    if (syncing || !session || !configured || !navigator.onLine) {
      if (!navigator.onLine) status('Offline: os dados locais serão sincronizados ao reconectar.');
      return;
    }
    syncing = true;
    updatedCount = 0;
    lastConflicts = [];
    lastError = '';
    status('Verificando dados dos dois dispositivos…', 'busy');
    let app = null, metaDb = null;
    try {
      await ensureSession();
      [app, metaDb] = await Promise.all([appDB(), metaDB()]);
      const owner = await storeAction(metaDb, META_STORE, 'readonly', st => st.get('__account'));
      if (owner && owner.user_id !== session.user_id)
        throw Error('Esta Central ja esta vinculada a outra conta. Preserve seus backups e nao misture cadastros de contas diferentes.');
      if (!owner) await storeAction(metaDb, META_STORE, 'readwrite', st =>
        st.put({ key: '__account', user_id: session.user_id }));
      const [local, meta, remote] = await Promise.all([localData(app), snapshots(metaDb), remoteRows()]);
      const allKeys = new Set([...local.keys(), ...meta.keys(), ...remote.keys()]);
      const problems = [];
      for (const key of allKeys) {
        const { store, id } = local.get(key) ||
          (remote.has(key) ? { store: remote.get(key).store, id: remote.get(key).record_id } :
          { store: key.split('\u0000')[0], id: key.split('\u0000')[1] });
        if (store === '__settings' && id !== 'global') continue;
        if (!STORES.includes(store) && store !== '__settings') continue;
        const l = local.get(key);
        const state = meta.get(key);
        const cloud = remote.get(key);
        const exists = Boolean(l);
        const hash = exists ? await fingerprint(l.data) : null;
        const localChanged = state
          ? (exists ? state.deleted || hash !== state.hash : !state.deleted)
          : exists;
        const cloudChanged = state ? (cloud ? Number(cloud.revision) !== Number(state.revision) : true) : Boolean(cloud);
        try {
          if (localChanged) {
            if (cloudChanged) {
              if (exists && cloud && !cloud.deleted_at && cloud.fingerprint === hash) {
                await saveSnapshot(metaDb, store, id, hash, cloud.revision, false);
              } else {
                problems.push({ store, id, message: 'Registro diferente nos dois aparelhos' });
              }
              continue;
            }
            const result = await cloudWrite(store, id, l?.data, hash, !exists, state?.revision || 0);
            if (!result?.ok) {
              problems.push({ store, id, message: 'Alteração simultânea detectada' });
            } else {
              await saveSnapshot(metaDb, store, id, hash, result.revision, !exists);
              updatedCount++;
            }
          } else if (cloudChanged && cloud) {
            // Confirma se ninguém editou o registro enquanto o download ocorria.
            const now = await localRecord(app, store, id);
            const nowHash = now ? await fingerprint(now) : null;
            if (nowHash !== hash) {
              problems.push({ store, id, message: 'Alteração local durante a atualização' });
              continue;
            }
            if (cloud.deleted_at) {
              if (exists) await deleteLocal(app, store, id);
              await saveSnapshot(metaDb, store, id, null, cloud.revision, true);
            } else {
              const record = await decode(cloud.payload);
              await putLocal(app, store, id, record);
              await saveSnapshot(metaDb, store, id, await fingerprint(record), cloud.revision, false);
            }
            updatedCount++;
          }
        } catch (e) {
          problems.push({ store, id, message: shortError(e) });
        }
      }
      lastConflicts = problems;
      if (problems.length) {
        status(`${updatedCount} atualização(ões) aplicada(s); ${problems.length} pendência(s) protegida(s) contra sobrescrita.`, 'error');
      } else {
        status(`Sincronização concluída. ${updatedCount} atualização(ões).`, 'ok');
      }
      renderDetails();
    } catch (e) {
      lastError = shortError(e);
      status('Erro de sincronização: ' + lastError, 'error');
      renderDetails();
    } finally {
      app?.close(); metaDb?.close(); syncing = false;
    }
  }

  function renderDetails() {
    if (!ui.details) return;
    ui.details.replaceChildren();
    if (lastError) {
      const p = document.createElement('p'); p.textContent = 'Erro: ' + lastError; ui.details.append(p);
    }
    if (updatedCount > 0) {
      const p = document.createElement('p');
      p.textContent = 'Para ver os dados recebidos em telas já abertas, toque em Atualizar telas.';
      ui.details.append(p);
    }
    if (lastConflicts.length) {
      const p = document.createElement('p');
      p.textContent = `Pendências: ${lastConflicts.length}. Não substituímos dados divergentes. Faça um backup ZIP antes de resolver.`;
      ui.details.append(p);
      const ul = document.createElement('ul');
      for (const c of lastConflicts.slice(0, 12)) {
        const li = document.createElement('li');
        li.textContent = `${c.store} / ${c.id}: ${c.message}`;
        ul.append(li);
      }
      ui.details.append(ul);
    }
  }
  function showSession() {
    if (!ui.loginBlock) return;
    ui.loginBlock.hidden = Boolean(session);
    ui.accountBlock.hidden = !session;
    ui.accountText.textContent = session ? 'Conta conectada. Os dois aparelhos devem usar a mesma conta.' : '';
    ui.syncButton.disabled = !session || !configured;
  }
  function mountUI() {
    const wrap = document.createElement('section');
    wrap.id = 'beneditaSyncV22';
    wrap.setAttribute('aria-label', 'Sincronização Benedita Studio 3D');
    wrap.innerHTML = `
<style>
#beneditaSyncV22{position:fixed;bottom:16px;right:14px;z-index:9999;font-family:system-ui,Arial,sans-serif;color:#172231}
#beneditaSyncV22 *{box-sizing:border-box}
#beneditaSyncV22 .bs22-toggle{border:0;background:#172231;color:#fff;box-shadow:0 3px 16px #0004;padding:11px 15px;border-radius:28px;font-size:13px;font-weight:700;cursor:pointer}
#beneditaSyncV22 .bs22-toggle[data-kind=ok]{background:#186447}
#beneditaSyncV22 .bs22-toggle[data-kind=error]{background:#9b4b20}
#beneditaSyncV22 .bs22-panel{position:absolute;bottom:48px;right:0;width:min(348px,calc(100vw - 28px));max-height:min(78vh,630px);overflow:auto;background:#fff;border:1px solid #d8e0e9;border-radius:15px;box-shadow:0 8px 38px #13213655;padding:18px;font-size:13px}
#beneditaSyncV22 h2{font-size:18px;margin:0 0 9px}
#beneditaSyncV22 p{font-size:13px;margin:9px 0;line-height:1.5}
#beneditaSyncV22 label{display:block;font-size:12px;font-weight:650;margin:10px 0 5px}
#beneditaSyncV22 input{display:block;width:100%;border:1px solid #bac7d6;border-radius:8px;padding:10px;background:#fff;color:#172231}
#beneditaSyncV22 .bs22-actions{display:flex;gap:7px;flex-wrap:wrap;margin-top:14px}
#beneditaSyncV22 .bs22-actions button{background:#172231;color:#fff;border:0;border-radius:8px;padding:9px 11px;font-size:12px;cursor:pointer}
#beneditaSyncV22 .bs22-actions button.bs22-secondary{background:#eaf0f5;color:#172231}
#beneditaSyncV22 button:disabled{opacity:.5;cursor:not-allowed}
#beneditaSyncV22 ul{max-height:135px;overflow:auto;padding-left:20px;font-size:11px}
#beneditaSyncV22 .bs22-warning{background:#fff6e9;padding:9px;border-radius:7px}
</style>
<button type="button" class="bs22-toggle" aria-expanded="false" aria-controls="bs22Panel">☁ Sincronização</button>
<div class="bs22-panel" id="bs22Panel" hidden>
  <h2>☁ Central Benedita v2.2</h2>
  <p id="bs22Status" role="status">Aguardando configuração.</p>
  <p class="bs22-warning" id="bs22Config" hidden>Configure o Supabase no arquivo sync-config-v22.js antes de ativar a sincronização. A Central continua funcionando localmente.</p>
  <div id="bs22Login">
    <form id="bs22Form" autocomplete="on">
      <label for="bs22Email">E-mail da conta Benedita</label>
      <input type="email" id="bs22Email" autocomplete="username" required>
      <label for="bs22Password">Senha</label>
      <input type="password" id="bs22Password" autocomplete="current-password" required>
      <div class="bs22-actions"><button type="submit" id="bs22Enter">Entrar e sincronizar</button></div>
    </form>
  </div>
  <div id="bs22Account" hidden><p id="bs22AccountText"></p>
    <div class="bs22-actions">
      <button type="button" id="bs22Sync">Sincronizar agora</button>
      <button type="button" id="bs22Reload" class="bs22-secondary">Atualizar telas</button>
      <button type="button" id="bs22Exit" class="bs22-secondary">Sair da conta</button>
    </div>
  </div>
  <div id="bs22Details" aria-live="polite"></div>
  <p><strong>Offline:</strong> os dados continuam no aparelho. Ao voltar a internet e abrir a Central, a sincronização será tentada. Mantenha backups ZIP.</p>
  <div class="bs22-actions"><button type="button" id="bs22Close" class="bs22-secondary">Fechar</button></div>
</div>`;
    document.body.append(wrap);
    const q = id => wrap.querySelector('#' + id);
    ui = {
      button: wrap.querySelector('.bs22-toggle'), panel: q('bs22Panel'),
      status: q('bs22Status'), details: q('bs22Details'),
      loginBlock: q('bs22Login'), accountBlock: q('bs22Account'),
      accountText: q('bs22AccountText'), syncButton: q('bs22Sync')
    };
    q('bs22Config').hidden = configured;
    q('bs22Form').querySelector('button').disabled = !configured;
    const toggle = open => { ui.panel.hidden = !open; ui.button.setAttribute('aria-expanded', String(open)); };
    ui.button.addEventListener('click', () => toggle(ui.panel.hidden));
    q('bs22Close').addEventListener('click', () => toggle(false));
    q('bs22Sync').addEventListener('click', () => syncNow());
    q('bs22Reload').addEventListener('click', () => location.reload());
    q('bs22Exit').addEventListener('click', () => {
      // A conta sai deste dispositivo; registros locais não são apagados.
      saveSession(null); lastError = ''; lastConflicts = [];
      status('Sessão encerrada; dados locais preservados.'); showSession(); renderDetails();
    });
    q('bs22Form').addEventListener('submit', async event => {
      event.preventDefault();
      const email = q('bs22Email').value.trim();
      const password = q('bs22Password').value;
      q('bs22Enter').disabled = true;
      status('Conectando com segurança…', 'busy');
      try { await login(email, password); q('bs22Password').value = ''; }
      catch (e) { lastError = shortError(e); status('Falha no login: ' + lastError, 'error'); renderDetails(); }
      finally { q('bs22Enter').disabled = !configured; }
    });
    if (!configured) status('Sincronização ainda não configurada.');
    else if (!session) status('Entre com sua conta para ativar a sincronização.');
    else status('Conta salva. Sincronização disponível.');
    showSession();
  }
  function autoSync() {
    if (configured && session) syncNow();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
  function init() {
    mountUI();
    window.addEventListener('online', autoSync);
    window.addEventListener('focus', autoSync);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) autoSync(); });
    setInterval(() => { if (!document.hidden) autoSync(); }, POLL_MS);
    autoSync();
  }
  // Disponível para diagnósticos sem revelar credenciais privadas.
  window.beneditaSyncV22 = Object.freeze({ sync: syncNow, version: '2.2-prototipo' });
})();
