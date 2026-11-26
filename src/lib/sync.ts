import type { Session } from '@supabase/supabase-js';
import supabase from './supabase';
import { signInWithGoogle, handleGoogleRedirect } from './googleAuth';

interface AppState {
  updatedAt?: number;
  lang: string;
  months: Record<string, unknown>;
}

interface BBApi {
  getState: () => AppState;
  replaceState: (s: AppState) => void;
}

declare global {
  interface Window {
    BB?: BBApi;
    BB_onChange?: (s: AppState) => void;
  }
}

type SyncKind = 'ok' | 'busy' | 'err';

const ICON_USER = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8.5" r="3.8"/><path d="M4.8 20c1.2-3.6 3.9-5.5 7.2-5.5s6 1.9 7.2 5.5"/></svg>';
const ICON_CLOSE = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/></svg>';

const STYLE = [
  '.sync-note{margin-left:8px;font-size:13px;color:var(--ink-soft);font-weight:600}',
  '.sync-note[data-kind="ok"]{color:var(--sage-deeper)}',
  '.sync-note[data-kind="err"]{color:var(--rose-deep)}',
  '.account-btn{gap:8px;white-space:nowrap}',
  '.account-btn svg.ic{width:18px;height:18px}',
  '.account-name{max-width:120px;overflow:hidden;text-overflow:ellipsis}',
  '@media (max-width:639px){.account-name{display:none}}',
  '.auth-note{color:var(--ink-soft);font-size:14px;margin-top:6px}',
  '.auth-or{display:flex;align-items:center;gap:10px;margin-top:18px;color:var(--ink-soft);font-size:13px}',
  '.auth-or::before,.auth-or::after{content:"";flex:1;height:1px;background:var(--line)}',
  '.auth-info{color:var(--sage-deeper);font-size:13.5px;font-weight:500;margin-top:10px}',
  '#authDialog{position:fixed;inset:0;margin:auto;width:min(480px,calc(100vw - 32px));height:fit-content;max-height:calc(100dvh - 32px);padding:0;border:none;background:transparent;overflow:visible}',
  '#authDialog .sheet{border-radius:28px;max-height:calc(100dvh - 32px);padding:24px 22px;box-shadow:var(--shadow-lg)}',
  '#authDialog .sheet-foot .btn{flex:1 1 auto}',
  '#authDialog .presets{margin-top:16px}',
].join('');

const DIALOG_HTML = `
<form class="sheet" id="authForm" novalidate>
  <div class="sheet-head">
    <h2 id="authTitle">Masuk untuk sync</h2>
    <button type="button" class="icon-btn" data-auth-close aria-label="Tutup">${ICON_CLOSE}</button>
  </div>
  <div id="authGuest">
    <p class="auth-note">Masuk supaya daftar belanja tersimpan online dan bisa dibuka di perangkat lain. Tanpa masuk, data tetap tersimpan di perangkat ini.</p>
    <div class="presets" role="group" aria-label="Mode masuk">
      <button type="button" class="chip" data-mode="in" aria-pressed="true">Masuk</button>
      <button type="button" class="chip" data-mode="up" aria-pressed="false">Daftar baru</button>
    </div>
    <div class="field">
      <label for="authEmail">Email</label>
      <input class="input" id="authEmail" type="email" autocomplete="email" placeholder="nama@email.com">
      <p class="err" id="authEmailErr" hidden></p>
    </div>
    <div class="field">
      <label for="authPass">Kata sandi</label>
      <input class="input" id="authPass" type="password" autocomplete="current-password" placeholder="Minimal 6 karakter">
      <p class="err" id="authPassErr" hidden></p>
    </div>
    <p class="err" id="authErr" hidden></p>
    <p class="auth-info" id="authInfo" hidden></p>
    <div class="sheet-foot"><button type="submit" class="btn btn-primary" id="authSubmit">Masuk</button></div>
    <div class="auth-or">atau</div>
    <div class="sheet-foot"><button type="button" class="btn btn-soft" id="googleBtn">Lanjut dengan Google</button></div>
  </div>
  <div id="authUser" hidden>
    <p class="auth-note" id="authWho"></p>
    <p class="auth-info">Daftar belanja otomatis tersinkron setiap kali kamu mengubah sesuatu.</p>
    <div class="sheet-foot"><button type="button" class="btn btn-soft" id="logoutBtn">Keluar</button></div>
  </div>
</form>`;

function $<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

function time(): string {
  return new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
}

function translateAuthError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/invalid login credentials/i.test(msg)) return 'Email atau kata sandi salah.';
  if (/already registered|already been registered/i.test(msg)) return 'Email ini sudah terdaftar. Coba masuk.';
  if (/email not confirmed/i.test(msg)) return 'Email belum dikonfirmasi. Cek kotak masuk kamu.';
  if (/rate limit|too many/i.test(msg)) return 'Terlalu banyak percobaan. Coba lagi sebentar.';
  return 'Terjadi kesalahan: ' + msg;
}

let mode: 'in' | 'up' = 'in';
let currentUserId: string | null = null;
let pushTimer: number | undefined;
let reconciling = false;

async function api(method: 'GET' | 'PUT', body?: unknown): Promise<unknown> {
  if (!supabase) throw new Error('Sync belum dikonfigurasi');
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error('Belum masuk');
  const res = await fetch('/api/sync', {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`);
  return json;
}

function setSync(kind: SyncKind, text: string) {
  const el = $('syncNote');
  el.hidden = false;
  el.dataset.kind = kind;
  el.textContent = text;
}

// Pull the online copy and reconcile with this device. Newest updatedAt wins.
async function reconcile() {
  const bb = window.BB;
  if (!bb || !currentUserId || reconciling) return;
  reconciling = true;
  setSync('busy', 'Menyinkronkan…');
  try {
    const remote = (await api('GET')) as { data: AppState; updated_at: string } | null;
    const local = bb.getState();
    const localT = Number(local.updatedAt) || 0;
    const remoteState = remote?.data ?? null;
    const remoteT = Number(remoteState?.updatedAt) || 0;

    if (remoteState && remoteT > localT) {
      bb.replaceState(remoteState);
    } else if (!remoteState || localT > remoteT) {
      await api('PUT', { data: bb.getState() });
    }
    setSync('ok', 'Tersinkron ' + time());
  } catch (err) {
    console.error('[sync] reconcile failed:', err);
    setSync('err', 'Sync gagal, data tetap aman di perangkat ini');
  } finally {
    reconciling = false;
  }
}

// Called by app.js on every real data change. Debounced upload.
function onLocalChange() {
  if (!currentUserId) return;
  setSync('busy', 'Menyimpan…');
  window.clearTimeout(pushTimer);
  pushTimer = window.setTimeout(async () => {
    const bb = window.BB;
    if (!bb || !currentUserId) return;
    try {
      await api('PUT', { data: bb.getState() });
      setSync('ok', 'Tersimpan online ' + time());
    } catch (err) {
      console.error('[sync] push failed:', err);
      setSync('err', 'Gagal menyimpan online, dicoba lagi saat ada perubahan');
    }
  }, 700);
}

export function initSync() {
  const client = supabase;
  if (!client) {
    console.info('[sync] Supabase env vars not configured; running in offline-only mode.');
    return;
  }

  const style = document.createElement('style');
  style.textContent = STYLE;
  document.head.appendChild(style);

  const dialog = document.createElement('dialog');
  dialog.id = 'authDialog';
  dialog.setAttribute('aria-labelledby', 'authTitle');
  dialog.innerHTML = DIALOG_HTML;
  document.body.appendChild(dialog);

  const topbar = document.querySelector('.topbar-inner');
  topbar?.insertAdjacentHTML(
    'beforeend',
    `<button type="button" class="btn btn-soft btn-sm account-btn" id="accountBtn" aria-haspopup="dialog">${ICON_USER}<span class="account-name" id="accountName">Masuk</span></button>`
  );
  $('foot').insertAdjacentHTML('beforeend', '<span class="sync-note" id="syncNote" hidden></span>');

  const form = $<HTMLFormElement>('authForm');
  const emailEl = $<HTMLInputElement>('authEmail');
  const passEl = $<HTMLInputElement>('authPass');
  const emailErr = $('authEmailErr');
  const passErr = $('authPassErr');
  const errEl = $('authErr');
  const infoEl = $('authInfo');
  const submitBtn = $<HTMLButtonElement>('authSubmit');

  const showErr = (msg: string) => { errEl.textContent = msg; errEl.hidden = !msg; infoEl.hidden = true; };
  const showInfo = (msg: string) => { infoEl.textContent = msg; infoEl.hidden = false; errEl.hidden = true; };
  const clearMsgs = () => { errEl.hidden = true; infoEl.hidden = true; emailErr.hidden = true; passErr.hidden = true; };
  const fieldErr = (input: HTMLInputElement, el: HTMLElement, msg: string) => {
    el.textContent = msg;
    el.hidden = !msg;
    if (msg) input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
    return !msg;
  };

  const openAuth = () => {
    if (!dialog.open) (dialog as HTMLDialogElement).showModal();
    document.documentElement.classList.add('modal-open');
  };
  const closeAuth = () => {
    if (dialog.open) (dialog as HTMLDialogElement).close();
  };
  dialog.addEventListener('close', () => document.documentElement.classList.remove('modal-open'));
  dialog.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    if (t === dialog || t.closest('[data-auth-close]')) closeAuth();
  });

  const refreshTitle = (user: boolean) => {
    $('authTitle').textContent = user ? 'Akun sync' : mode === 'in' ? 'Masuk untuk sync' : 'Buat akun baru';
  };

  const setMode = (m: 'in' | 'up') => {
    mode = m;
    document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((b) => {
      b.setAttribute('aria-pressed', String(b.dataset.mode === m));
    });
    submitBtn.textContent = m === 'in' ? 'Masuk' : 'Daftar';
    passEl.setAttribute('autocomplete', m === 'in' ? 'current-password' : 'new-password');
    clearMsgs();
    refreshTitle(!!currentUserId);
  };

  const applyUser = (session: Session | null) => {
    const user = session?.user ?? null;
    currentUserId = user?.id ?? null;
    const email = user?.email ?? '';
    $('accountName').textContent = user ? email.split('@')[0] : 'Masuk';
    $('accountBtn').title = user ? 'Akun sync: ' + email : 'Masuk untuk sync online';
    $('authGuest').hidden = !!user;
    $('authUser').hidden = !user;
    $('authWho').textContent = user ? 'Masuk sebagai ' + email : '';
    refreshTitle(!!user);
    if (!user) $('syncNote').hidden = true;
    if (user && dialog.open) closeAuth();
  };

  $('accountBtn').addEventListener('click', openAuth);
  document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((b) => {
    b.addEventListener('click', () => setMode(b.dataset.mode === 'up' ? 'up' : 'in'));
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = emailEl.value.trim();
    const pass = passEl.value;
    const okEmail = fieldErr(emailEl, emailErr, /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? '' : 'Masukkan email yang valid');
    const okPass = fieldErr(passEl, passErr, pass.length >= 6 ? '' : 'Kata sandi minimal 6 karakter');
    if (!okEmail || !okPass) {
      (okEmail ? passEl : emailEl).focus();
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Memproses…';
    try {
      if (mode === 'in') {
        const { error } = await client.auth.signInWithPassword({ email, password: pass });
        if (error) throw error;
        closeAuth();
      } else {
        const { data, error } = await client.auth.signUp({ email, password: pass });
        if (error) throw error;
        if (data.session) closeAuth();
        else showInfo('Akun dibuat. Cek email untuk konfirmasi, lalu masuk.');
      }
    } catch (err) {
      showErr(translateAuthError(err));
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = mode === 'in' ? 'Masuk' : 'Daftar';
    }
  });

  $('googleBtn').addEventListener('click', () => {
    clearMsgs();
    if (!signInWithGoogle('Belanja Bulanan')) showErr('Masuk dengan Google belum tersedia.');
  });

  $('logoutBtn').addEventListener('click', async () => {
    await client.auth.signOut();
    closeAuth();
  });

  client.auth.onAuthStateChange((event, session) => {
    applyUser(session);
    if (session && (event === 'SIGNED_IN' || event === 'INITIAL_SESSION')) reconcile();
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && currentUserId) reconcile();
  });

  window.BB_onChange = onLocalChange;
  handleGoogleRedirect();
  applyUser(null);
}
