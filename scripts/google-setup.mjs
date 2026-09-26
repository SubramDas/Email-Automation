import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const host = "127.0.0.1";
const port = 8788;
const redirectUri = `http://${host}:${port}/callback`;
const varsPath = resolve(".dev.vars");
const scopes = [
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/drive.file",
];
const varsText = await readFile(varsPath, "utf8").catch(() => "");
const values = Object.fromEntries(
  varsText
    .split(/\r?\n/)
    .map((line) => line.match(/^([A-Z0-9_]+)=(.*)$/))
    .filter(Boolean)
    .map((match) => [match[1], match[2]]),
);
const required = [
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_API_KEY",
  "GOOGLE_CLOUD_PROJECT_NUMBER",
];
const missing = required.filter((key) => !values[key]);
if (missing.length) {
  console.error(`Add these values to .dev.vars first: ${missing.join(", ")}`);
  process.exit(1);
}

let state;
let accessToken;
let refreshToken;
let templateFile;
let resumeFile;

function reply(res, status, body, type = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "content-type": type,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "content-security-policy": "default-src 'none'; script-src 'self' 'unsafe-inline' https://apis.google.com; style-src 'unsafe-inline'; connect-src 'self' https://www.googleapis.com https://oauth2.googleapis.com; frame-src https://docs.google.com",
  });
  res.end(body);
}

function pickerPage() {
  const apiKey = JSON.stringify(values.GOOGLE_API_KEY).replaceAll("<", "\\u003c");
  const token = JSON.stringify(accessToken).replaceAll("<", "\\u003c");
  const appId = JSON.stringify(values.GOOGLE_CLOUD_PROJECT_NUMBER);
  return `<!doctype html><meta charset="utf-8"><title>Select Drive files</title>
<main style="font:16px system-ui;max-width:44rem;margin:3rem auto"><h1>Select your Drive files</h1>
<p>Choose <code>email-template.txt</code> first, then the PDF resume. The selected files and refresh token will be saved to the ignored local <code>.dev.vars</code> file.</p>
<button id="template" disabled>Select template (.txt)</button> <button id="resume" disabled>Select resume (.pdf)</button><p id="status">Loading Picker…</p></main>
<script>
const apiKey=${apiKey}, token=${token}, appId=${appId};let kind='template';
const statusEl=document.getElementById('status'),templateButton=document.getElementById('template'),resumeButton=document.getElementById('resume');
function pickerLoaded(){gapi.load('picker',()=>{statusEl.textContent='Choose the template.';templateButton.disabled=false})}
function showPicker(k){kind=k;const types=k==='template'?'text/plain':'application/pdf';const view=new google.picker.DocsView(google.picker.ViewId.DOCS).setMimeTypes(types).setMode(google.picker.DocsViewMode.LIST);new google.picker.PickerBuilder().addView(view).setOAuthToken(token).setDeveloperKey(apiKey).setAppId(appId).setCallback(picked).build().setVisible(true)}
async function picked(data){if(data.action!==google.picker.Action.PICKED||!data.docs?.length)return;statusEl.textContent='Checking selected file…';try{const r=await fetch('/select',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({kind,id:data.docs[0].id})});const x=await r.json();if(!r.ok)throw new Error(x.error);if(x.done){statusEl.textContent='Setup complete. Template: '+x.template+'; resume: '+x.resume+'. You can close this page and press Ctrl+C in the terminal.';templateButton.disabled=true;resumeButton.disabled=true}else{statusEl.textContent='Template selected: '+x.name+'. Now select the PDF resume.';templateButton.disabled=true;resumeButton.disabled=false}}catch(e){statusEl.textContent=e.message||'Could not save selection.'}}
templateButton.onclick=()=>showPicker('template');resumeButton.onclick=()=>showPicker('resume');
</script><script src="https://apis.google.com/js/api.js" onload="pickerLoaded()"></script>`;
}

const server = createServer(async (req, res) => {
  const origin = `http://${host}:${port}`;
  const url = new URL(req.url ?? "/", origin);
  if (req.method === "GET" && url.pathname === "/") {
    return reply(res, 200, '<!doctype html><meta charset="utf-8"><h1>Google setup</h1><p>This one-time local setup grants the app access to Gmail drafts and only the Drive files you select.</p><a href="/start">Continue with Google</a>', "text/html; charset=utf-8");
  }
  if (req.method === "GET" && url.pathname === "/start") {
    state = randomBytes(32).toString("base64url");
    const auth = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    auth.search = new URLSearchParams({
      client_id: values.GOOGLE_CLIENT_ID,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: scopes.join(" "),
      access_type: "offline",
      prompt: "select_account consent",
      state,
    }).toString();
    res.writeHead(302, { location: auth.toString(), "cache-control": "no-store" });
    return res.end();
  }
  if (req.method === "GET" && url.pathname === "/callback") {
    if (!state || url.searchParams.get("state") !== state) return reply(res, 400, "OAuth state check failed. Restart setup.");
    state = undefined;
    if (url.searchParams.has("error")) return reply(res, 400, "Google authorization was cancelled or denied.");
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code: url.searchParams.get("code") ?? "",
        client_id: values.GOOGLE_CLIENT_ID,
        client_secret: values.GOOGLE_CLIENT_SECRET,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    });
    const result = await response.json();
    if (!response.ok || !result.access_token || !result.refresh_token) return reply(res, 400, "Google did not return an offline refresh token. Restart setup and approve access.");
    accessToken = result.access_token;
    refreshToken = result.refresh_token;
    return reply(res, 200, pickerPage(), "text/html; charset=utf-8");
  }
  if (req.method === "POST" && url.pathname === "/select") {
    if (req.headers.origin !== origin || !accessToken || !refreshToken) return reply(res, 403, "Request not allowed.");
    if (!req.headers["content-type"]?.startsWith("application/json")) return reply(res, 415, "JSON required.");
    let raw = "";
    for await (const part of req) {
      raw += part;
      if (raw.length > 4096) return reply(res, 413, "Request too large.");
    }
    try {
      const item = JSON.parse(raw);
      if (!["template", "resume"].includes(item.kind)) return reply(res, 400, JSON.stringify({ error: "Invalid selection type." }), "application/json");
      const metaResponse = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(item.id)}?fields=id,name,mimeType,size`, { headers: { authorization: `Bearer ${accessToken}` } });
      if (!metaResponse.ok) throw new Error("Drive could not verify that file.");
      const meta = await metaResponse.json();
      const expected = item.kind === "template" ? "text/plain" : "application/pdf";
      if (meta.mimeType !== expected) throw new Error(item.kind === "template" ? "Select the uploaded plain-text email-template.txt file." : "Select a PDF resume.");
      if (Number(meta.size ?? 0) > 20 * 1024 * 1024) throw new Error("The selected file is larger than 20 MB.");
      if (item.kind === "template") templateFile = meta;
      else resumeFile = meta;
      if (templateFile && resumeFile) {
        if (templateFile.id === resumeFile.id) throw new Error("Select separate template and resume files.");
        const replacements = {
          GOOGLE_REFRESH_TOKEN: refreshToken,
          DRIVE_TEMPLATE_FILE_ID: templateFile.id,
          DRIVE_RESUME_FILE_ID: resumeFile.id,
        };
        const lines = varsText.split(/\r?\n/);
        const written = new Set();
        const output = lines.map((line) => {
          const match = line.match(/^([A-Z0-9_]+)=/);
          if (!match || !(match[1] in replacements)) return line;
          written.add(match[1]);
          return `${match[1]}=${replacements[match[1]]}`;
        });
        for (const [key, value] of Object.entries(replacements)) if (!written.has(key)) output.push(`${key}=${value}`);
        const tempPath = `${varsPath}.tmp`;
        await writeFile(tempPath, `${output.join("\n").replace(/\n+$/, "")}\n`, { mode: 0o600 });
        await chmod(tempPath, 0o600);
        await rename(tempPath, varsPath);
        return reply(res, 200, JSON.stringify({ done: true, template: templateFile.name, resume: resumeFile.name }), "application/json; charset=utf-8");
      }
      return reply(res, 200, JSON.stringify({ done: false, name: meta.name }), "application/json; charset=utf-8");
    } catch (error) {
      return reply(res, 400, JSON.stringify({ error: error instanceof Error ? error.message : "Could not select file." }), "application/json; charset=utf-8");
    }
  }
  return reply(res, 404, "Not found.");
});

server.listen(port, host, () => {
  console.log(`Open http://${host}:${port} in your browser to authorize and select files.`);
  console.log("The refresh token and file IDs are saved to ignored .dev.vars and are never printed.");
  console.log("Press Ctrl+C after setup completes.");
});
