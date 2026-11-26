import supabase from './supabase';

const isMobile = () => /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

function buildGoogleUrl(appName: string): string | null {
  const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined;
  const redirectUri = import.meta.env.VITE_GOOGLE_AUTH_PROXY as string | undefined;
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
  const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
  if (!clientId || !redirectUri) return null;
  const state = btoa(JSON.stringify({ origin: window.location.origin, appName, supabaseUrl, supabaseAnonKey }));
  return `https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=openid%20email%20profile&prompt=select_account&state=${encodeURIComponent(state)}`;
}

export function signInWithGoogle(appName = 'this app'): boolean {
  if (!supabase) return false;
  const url = buildGoogleUrl(appName);
  if (!url) {
    console.warn('[google-auth] Missing VITE_GOOGLE_CLIENT_ID or VITE_GOOGLE_AUTH_PROXY');
    return false;
  }

  // Always use window.open() so the app's preview iframe is never navigated away.
  const popup = window.open(url, 'google-auth', isMobile() ? '' : 'width=500,height=600');

  const handler = async (event: MessageEvent) => {
    if (event.source !== popup) return;
    if (event.data?.type === 'google-auth-denied') {
      window.removeEventListener('message', handler);
      return;
    }
    if (event.data?.type !== 'google-auth-success') return;
    window.removeEventListener('message', handler);
    if (!supabase) return;
    const { access_token, refresh_token } = event.data;
    const { error } = await supabase.auth.setSession({ access_token, refresh_token });
    if (error) console.error('[google-auth] setSession failed:', error.message);
  };
  window.addEventListener('message', handler);
  return true;
}

// Handles the redirect fallback when the popup could not reach this tab.
export async function handleGoogleRedirect() {
  if (!supabase) return;
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  if (!fragment.has('google_auth_popup')) return;
  const { data, error } = await supabase.auth.getSession();
  if (error || !data.session) {
    console.error('[google-auth] redirect sign-in failed:', error?.message);
    return;
  }
  window.close();
}
