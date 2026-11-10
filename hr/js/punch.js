// Punching from the phone (neon/021_mobile_punch.sql): the phone's own Face ID /
// fingerprint through a passkey, and a selfie. The database checks the phone's
// signature, the location and the photo; nothing here is trusted on its own.

const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const urlToB64 = (s) => s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=");

export const supported = () => !!(window.PublicKeyCredential && navigator.credentials && navigator.mediaDevices?.getUserMedia);
// the phone has a face / finger / screen lock we can ask for
export async function hasLock() {
  try { return supported() && await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable(); } catch { return false; }
}

const deviceLabel = () => {
  const ua = navigator.userAgent;
  return /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? (ua.match(/Android [\d.]+; ([^;)]+)/)?.[1]?.trim() || "Android") : /Mac/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : "Device";
};

// Makes a passkey on this phone and returns what the database keeps: its id and public key.
export async function register(rpId, userName, displayName) {
  const cred = await navigator.credentials.create({ publicKey: {
    rp: { id: rpId, name: "Everest Eco System" },
    user: { id: crypto.getRandomValues(new Uint8Array(16)), name: userName, displayName },
    challenge: crypto.getRandomValues(new Uint8Array(32)),
    pubKeyCredParams: [{ type: "public-key", alg: -7 }],
    authenticatorSelection: { authenticatorAttachment: "platform", userVerification: "required", residentKey: "preferred" },
    attestation: "none", timeout: 60000,
  } });
  const spki = cred.response.getPublicKey?.();
  if (!spki || cred.response.getPublicKeyAlgorithm?.() !== -7) throw new Error("unsupported phone");
  const key = await crypto.subtle.importKey("spki", spki, { name: "ECDSA", namedCurve: "P-256" }, true, ["verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", key);
  return { cred: cred.id, x: urlToB64(jwk.x), y: urlToB64(jwk.y), label: deviceLabel() };
}

// DER (30 len 02 len r 02 len s) to r || s, 32 bytes each
function rawSig(der) {
  const d = new Uint8Array(der); let i = d[1] & 0x80 ? 2 + (d[1] & 0x7f) : 2;
  const part = () => { const len = d[i + 1]; let v = d.slice(i + 2, i + 2 + len); i += 2 + len; while (v.length > 32 && v[0] === 0) v = v.slice(1); const out = new Uint8Array(32); out.set(v, 32 - v.length); return out; };
  const r = part(), s = part(), out = new Uint8Array(64); out.set(r); out.set(s, 32); return out;
}

// Asks the phone for the face / finger and returns its signed answer to our challenge.
export async function assert(ch) {
  const a = await navigator.credentials.get({ publicKey: {
    challenge: fromB64(ch.challenge), rpId: ch.rp_id, userVerification: "required", timeout: 60000,
    allowCredentials: [{ type: "public-key", id: fromB64(urlToB64(ch.cred)), transports: ["internal"] }],
  } });
  return { auth: b64(a.response.authenticatorData), client: b64(a.response.clientDataJSON), sig: b64(rawSig(a.response.signature)) };
}

// One frame from the front camera as a small JPEG (base64, no prefix). `video` shows the preview.
export async function selfie(video) {
  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } }, audio: false });
  try {
    video.srcObject = stream; video.muted = true; video.playsInline = true;
    await video.play();
    await new Promise((r) => (video.readyState >= 2 && video.videoWidth ? r() : video.addEventListener("loadeddata", r, { once: true })));
    await new Promise((r) => setTimeout(r, 600));   // let the camera settle its exposure
    const w = 320, h = Math.round((video.videoHeight / video.videoWidth) * w) || 240;
    const c = document.createElement("canvas"); c.width = w; c.height = h;
    c.getContext("2d").drawImage(video, 0, 0, w, h);
    let q = 0.72, data = c.toDataURL("image/jpeg", q);
    while (data.length > 78000 && q > 0.3) { q -= 0.12; data = c.toDataURL("image/jpeg", q); }
    return data.split(",")[1];
  } finally { stream.getTracks().forEach((t) => t.stop()); video.srcObject = null; }
}
