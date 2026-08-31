import { config, ACTIVATION_PHRASE } from "../config.js";

const NUMBER = config.channel.provider === "sendblue"
  ? config.channel.sendblue.from
  : config.channel.twilio.from;

const shell = (title: string, body: string) => `<!doctype html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin:0; min-height:100vh; display:grid; place-items:center;
         font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
         background:#fbfbf9; color:#111; padding:24px; }
  @media (prefers-color-scheme: dark){ body{ background:#0e0e10; color:#f2f2f2 } }
  main { max-width:420px; text-align:center }
  h1 { font-size:clamp(28px,7vw,40px); margin:0 0 12px; letter-spacing:-.02em }
  p { opacity:.72; margin:0 0 28px }
  a.cta { display:inline-block; background:#0b84fe; color:#fff; text-decoration:none;
          padding:15px 30px; border-radius:999px; font-weight:600 }
  small { display:block; margin-top:28px; opacity:.45; font-size:12px }
</style></head><body><main>${body}</main></body></html>`;

/**
 * The deep link IS the signup. Note the platform split: iOS wants `&body=`
 * after the number, Android wants `?body=` — getting this wrong silently
 * drops half the funnel.
 */
export function landingPage(): string {
  const encoded = encodeURIComponent(ACTIVATION_PHRASE);
  return shell(
    "piper",
    `<h1>piper</h1>
     <p>the friend who actually remembers what you said you'd do.</p>
     <a class="cta" id="cta" href="sms:${NUMBER}&body=${encoded}">text piper</a>
     <small>an ai, over text. $19.99/mo or $9.99/mo billed yearly, after a free trial.
     msg &amp; data rates may apply. reply STOP to opt out.</small>
     <script>
       var a = document.getElementById('cta');
       if (!/iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent)) {
         a.href = "sms:${NUMBER}?body=${encoded}";
       }
     </script>`,
  );
}

export function notice(title: string, sub: string): string {
  return shell(title, `<h1>${title}</h1><p>${sub}</p>`);
}
