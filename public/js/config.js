// Which Firebase project this page talks to.
//
// On Firebase Hosting, the reserved URL /__/firebase/init.json returns the web
// config of the project the site is deployed in, so the same code runs on
//   family.vaschuk.com      → project vaschuk-com            (production)
//   family-dev.vaschuk.com  → project family-dev-vaschuk-com (dev/testing)
// A local preview (python -m http.server) has no init.json and uses production.
// None of these values are secrets; access is enforced by firestore.rules.

const PROD = {
  apiKey: "AIzaSyC1XotJSjFhLQQo3i8KNO7xpLHeO8URHOY",
  authDomain: "vaschuk-com.firebaseapp.com",
  projectId: "vaschuk-com",
  appId: "1:1059072294008:web:8272aff3b02d2d7129818d",
  messagingSenderId: "1059072294008",
};

// Web push (VAPID) public keys, per project: Firebase console → Project
// settings → Cloud Messaging → Web Push certificates. Empty = no push there.
const VAPID = {
  "vaschuk-com": "BHwxsnOIOUep77eJSg59BF5ZnboXI1tyOlCRwJbxdWj-yD-pluV1ax7kkLex0vAOiDveY2guqsWpPJ4JHKJBTPs",
  "family-dev-vaschuk-com": "",
};

async function load() {
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
  if (!local) {
    try {
      const res = await fetch("/__/firebase/init.json", { cache: "no-store" });
      if (res.ok) {
        const c = await res.json();
        if (c.projectId && c.apiKey) return c;
      }
    } catch {}
  }
  return PROD;
}

export const firebaseConfig = await load();
export const ENV = firebaseConfig.projectId === PROD.projectId ? "prod" : "dev";
export const VAPID_KEY = VAPID[firebaseConfig.projectId] || "";

// Dev deploys write /version.json (branch, commit, time) so testers can see
// what they're looking at.
export const BUILD = ENV === "dev"
  ? await fetch("/version.json", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null)
  : null;

if (ENV === "dev") {
  document.title = "DEV · " + document.title;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", "#5f6fb8");
  const show = () => {
    for (const el of document.querySelectorAll("[data-env-badge]")) {
      el.hidden = false;
      el.textContent = "DEV" + (BUILD ? ` · ${BUILD.branch} · ${String(BUILD.commit).slice(0, 7)}` : "");
      el.title = BUILD ? `Deployed ${BUILD.deployedAt} from ${BUILD.branch} (${BUILD.commit})` : "Dev environment";
    }
  };
  document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", show) : show();
}
