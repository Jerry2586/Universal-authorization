// Presentation only: this bootstrap never reads credentials or grants authorization.
export function restoreStartupAppearance(profile) {
  const root = document.documentElement;
  let mode = profile.editor ? 'light' : 'dark';
  try {
    if (profile.editor) {
      mode = localStorage.getItem('appgog_studio_appearance') === 'dark' ? 'dark' : 'light';
    } else {
      const preferences = JSON.parse(localStorage.getItem('appgog_public_appearance_v1') || '{}') || {};
      const saved = localStorage.getItem('appgog_theme');
      const preferred = String(preferences.allow_user_appearance) !== '0' && ['light', 'dark'].includes(saved)
        ? saved : preferences.default_appearance;
      mode = preferred === 'system'
        ? (typeof matchMedia === 'function' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
          : (preferences.appearance_fallback === 'light' ? 'light' : 'dark'))
        : (preferred === 'light' ? 'light' : 'dark');
    }
  } catch { /* Storage blocked or malformed: use the source theme's default palette. */ }
  root.dataset.theme = mode;
  if (profile.editor) root.dataset.studioTheme = mode;
  root.style.setProperty('--appgog-startup-bg', profile[mode]);
  root.style.setProperty('--appgog-startup-scheme', mode);
}

// Read only literal colors from the actual source; never execute uploaded CSS/JS.
export function startupPresentationProfile(files, root, html) {
  const tokens = files.get(`${root}assets/css/tokens.css`)?.toString('utf8') || '';
  const boot = files.get(`${root}assets/js/theme-boot.js`)?.toString('utf8') || '';
  const editorCss = files.get(`${root}assets/css/theme-editor.css`)?.toString('utf8') || '';
  if (!boot.includes('appgog_boot_background') || !tokens.includes('--bg-0')) return null;
  const literal = (value, fallback) => /^#[\da-f]{6}$/i.test(value || '') ? value : fallback;
  const editor = /id=["']editorTabs["']/.test(html);
  const dark = editor ? editorCss.match(/\.editor-body\s*\{\s*background:\s*(#[\da-f]{6})[;\s]/i)?.[1]
    : tokens.match(/--bg-0:\s*(#[\da-f]{6})[;\s]/i)?.[1];
  const light = editor ? editorCss.match(/html\[data-studio-theme=["']?light["']?\]\s*\.editor-body\s*\{\s*background:\s*(#[\da-f]{6})[;\s]/i)?.[1]
    : tokens.match(/html\[data-theme=["']?light["']?\]\s*\{\s*--bg-0:\s*(#[\da-f]{6})[;\s]/i)?.[1];
  return { editor, dark: literal(dark, '#05070d'), light: literal(light, '#f5f6fb') };
}

export function initialLockMarkup(profile = null) {
  const fallback = profile ? profile[profile.editor ? 'light' : 'dark'] : '#f6f7fb';
  const background = `var(--appgog-startup-bg,var(--bg-0,${fallback}))`;
  const selector = 'html:not(.__appgog_unlocked)';
  const style = `<style data-appgog-initial-lock>${selector}{background:${background};color-scheme:var(--appgog-startup-scheme,${profile && !profile.editor ? 'dark' : 'light'})}${selector} body{background:${background}!important;transition:none!important}${selector} body>*:not(#__appgog_gate){visibility:hidden!important}${selector} body::before{content:"";position:fixed;inset:0;background:${background};pointer-events:none}${profile ? `html[data-theme-pending]::after{content:""!important;background:var(--bg-0,${background})!important}html{background-color:var(--bg-0,${background})}` : ''}</style>`;
  return style + (profile ? `<script data-appgog-startup-appearance>(${restoreStartupAppearance.toString()})(${JSON.stringify(profile)});</script>` : '');
}
