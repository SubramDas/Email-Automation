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
  "https://www.googleapis.com/auth/gmail.readonly",
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
const fileKinds = ["template", "resume", "followup1", "followup2", "followup3"];
const selectedFiles = {};

function reply(res, status, body, type = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "content-type": type,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "content-security-policy":
      "default-src 'none'; script-src 'self' 'unsafe-inline' https://apis.google.com; style-src 'unsafe-inline'; connect-src 'self' https://www.googleapis.com https://oauth2.googleapis.com; frame-src https://docs.google.com",
  });
  res.end(body);
}

function pickerPage() {
  const apiKey = JSON.stringify(values.GOOGLE_API_KEY).replaceAll(
    "<",
    "\\u003c",
  );
  const token = JSON.stringify(accessToken).replaceAll("<", "\\u003c");
  const appId = JSON.stringify(values.GOOGLE_CLOUD_PROJECT_NUMBER);
  return `<!doctype html><meta charset="utf-8"><title>Select Drive files</title>
<main style="font:16px system-ui;max-width:44rem;margin:3rem auto"><h1>Select your Drive files</h1>
<p>Select, in order, the original template, PDF resume, and three follow-up templates. The selected files and refresh token will be saved to ignored local <code>.dev.vars</code>.</p>
<button id="select" disabled>Select next file</button><p id="status">Loading Picker…</p></main>
<script>
const apiKey=${apiKey}, token=${token}, appId=${appId};let kind='template',step=0;
const kinds=['template','resume','followup1','followup2','followup3'];const labels=['original template (.txt)','resume (.pdf)','follow-up 1 template (.txt)','follow-up 2 template (.txt)','follow-up 3 template (.txt)'];
const statusEl=document.getElementById('status'),selectButton=document.getElementById('select');
function pickerLoaded(){gapi.load('picker',()=>{statusEl.textContent='Select '+labels[step]+'.';selectButton.disabled=false})}
function showPicker(){kind=kinds[step];const types=kind==='resume'?'application/pdf':'text/plain';const view=new google.picker.DocsView(google.picker.ViewId.DOCS).setMimeTypes(types).setMode(google.picker.DocsViewMode.LIST);new google.picker.PickerBuilder().addView(view).setOAuthToken(token).setDeveloperKey(apiKey).setAppId(appId).setCallback(picked).build().setVisible(true)}
async function picked(data){if(data.action!==google.picker.Action.PICKED||!data.docs?.length)return;statusEl.textContent='Checking selected file…';try{const r=await fetch('/select',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({kind,id:data.docs[0].id})});const x=await r.json();if(!r.ok)throw new Error(x.error);step++;if(x.done){statusEl.textContent='Setup complete. Selected files: '+x.files.join(', ')+'. Close this page and press Ctrl+C in the terminal.';selectButton.disabled=true}else{statusEl.textContent='Selected '+x.name+'. Next select '+labels[step]+'.'}}catch(e){statusEl.textContent=e.message||'Could not save selection.'}}
selectButton.onclick=showPicker;
</script><script src="https://apis.google.com/js/api.js" onload="pickerLoaded()"></script>`;
}

const server = createServer(async (req, res) => {
  const origin = `http://${host}:${port}`;
  const url = new URL(req.url ?? "/", origin);
  if (req.method === "GET" && url.pathname === "/") {
    return reply(
      res,
      200,
      '<!doctype html><meta charset="utf-8"><h1>Google setup</h1><p>This local setup grants the app access to Gmail drafts and read-only Gmail message status, plus only the Drive files you select.</p><a href="/start">Continue with Google</a>',
      "text/html; charset=utf-8",
    );
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
    res.writeHead(302, {
      location: auth.toString(),
      "cache-control": "no-store",
    });
    return res.end();
  }
  if (req.method === "GET" && url.pathname === "/callback") {
    if (!state || url.searchParams.get("state") !== state)
      return reply(res, 400, "OAuth state check failed. Restart setup.");
    state = undefined;
    if (url.searchParams.has("error"))
      return reply(res, 400, "Google authorization was cancelled or denied.");
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
    if (!response.ok || !result.access_token || !result.refresh_token)
      return reply(
        res,
        400,
        "Google did not return an offline refresh token. Restart setup and approve access.",
      );
    accessToken = result.access_token;
    refreshToken = result.refresh_token;
    return reply(res, 200, pickerPage(), "text/html; charset=utf-8");
  }
  if (req.method === "POST" && url.pathname === "/select") {
    if (req.headers.origin !== origin || !accessToken || !refreshToken)
      return reply(res, 403, "Request not allowed.");
    if (!req.headers["content-type"]?.startsWith("application/json"))
      return reply(res, 415, "JSON required.");
    let raw = "";
    for await (const part of req) {
      raw += part;
      if (raw.length > 4096) return reply(res, 413, "Request too large.");
    }
    try {
      const item = JSON.parse(raw);
      if (!fileKinds.includes(item.kind))
        return reply(
          res,
          400,
          JSON.stringify({ error: "Invalid selection type." }),
          "application/json",
        );
      const metaResponse = await fetch(
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(item.id)}?fields=id,name,mimeType,size`,
        { headers: { authorization: `Bearer ${accessToken}` } },
      );
      if (!metaResponse.ok)
        throw new Error("Drive could not verify that file.");
      const meta = await metaResponse.json();
      const expected =
        item.kind === "resume" ? "application/pdf" : "text/plain";
      if (meta.mimeType !== expected)
        throw new Error(
          item.kind === "resume"
            ? "Select a PDF resume."
            : "Select an uploaded plain-text .txt template.",
        );
      if (Number(meta.size ?? 0) > 20 * 1024 * 1024)
        throw new Error("The selected file is larger than 20 MB.");
      selectedFiles[item.kind] = meta;
      if (fileKinds.every((kind) => selectedFiles[kind])) {
        if (
          new Set(Object.values(selectedFiles).map((file) => file.id)).size !==
          fileKinds.length
        )
          throw new Error(
            "Select a different Drive file for each template and resume.",
          );
        const replacements = {
          GOOGLE_REFRESH_TOKEN: refreshToken,
          DRIVE_TEMPLATE_FILE_ID: selectedFiles.template.id,
          DRIVE_RESUME_FILE_ID: selectedFiles.resume.id,
          DRIVE_FOLLOWUP_1_FILE_ID: selectedFiles.followup1.id,
          DRIVE_FOLLOWUP_2_FILE_ID: selectedFiles.followup2.id,
          DRIVE_FOLLOWUP_3_FILE_ID: selectedFiles.followup3.id,
        };
        const lines = varsText.split(/\r?\n/);
        const written = new Set();
        const output = lines.map((line) => {
          const match = line.match(/^([A-Z0-9_]+)=/);
          if (!match || !(match[1] in replacements)) return line;
          written.add(match[1]);
          return `${match[1]}=${replacements[match[1]]}`;
        });
        for (const [key, value] of Object.entries(replacements))
          if (!written.has(key)) output.push(`${key}=${value}`);
        const tempPath = `${varsPath}.tmp`;
        await writeFile(
          tempPath,
          `${output.join("\n").replace(/\n+$/, "")}\n`,
          { mode: 0o600 },
        );
        await chmod(tempPath, 0o600);
        await rename(tempPath, varsPath);
        return reply(
          res,
          200,
          JSON.stringify({
            done: true,
            files: Object.values(selectedFiles).map((file) => file.name),
          }),
          "application/json; charset=utf-8",
        );
      }
      return reply(
        res,
        200,
        JSON.stringify({ done: false, name: meta.name }),
        "application/json; charset=utf-8",
      );
    } catch (error) {
      return reply(
        res,
        400,
        JSON.stringify({
          error:
            error instanceof Error ? error.message : "Could not select file.",
        }),
        "application/json; charset=utf-8",
      );
    }
  }
  return reply(res, 404, "Not found.");
});

server.listen(port, host, () => {
  console.log(
    `Open http://${host}:${port} in your browser to authorize and select files.`,
  );
  console.log(
    "The refresh token and file IDs are saved to ignored .dev.vars and are never printed.",
  );
  console.log("Press Ctrl+C after setup completes.");
});
