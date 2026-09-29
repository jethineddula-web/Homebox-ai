HOMEBOX 1.0 — let any web AI work in a folder on your computer
by Jethin Production
====================================================================

WHAT IT DOES
Homebox turns ONE folder on your computer into a safe sandbox for AI.
Open an AI chat website (LMArena, ChatGPT, Gemini, Claude, DeepSeek,
Grok, Qwen, Mistral, Kimi, Perplexity, Copilot, Poe…), give it a task,
and it can read, create and edit files in that folder. You approve
every change, and every change can be undone.


STEP 1 — START THE APP
  Windows : double-click Homebox.exe
            If Windows says "Windows protected your PC", click
            "More info" → "Run anyway" (the app isn't code-signed yet).
  macOS   : drag Homebox.app into Applications, then double-click it.
            If macOS says it can't be opened: open System Settings →
            Privacy & Security → scroll down → "Open Anyway".
            (Apple Silicon = M1/M2/M3/M4 Macs. Intel = older Macs.)
  Linux   : run ./homebox

  The Homebox control panel opens in your browser
  (http://127.0.0.1:7777). Your sandbox folder is "Homebox Workspace"
  in your home folder — you can pick another one in the panel.

STEP 2 — INSTALL THE BROWSER EXTENSION (Chrome, Edge, Brave, Opera)
  1. Open chrome://extensions  (Edge: edge://extensions)
  2. Turn on "Developer mode" (top right).
  3. Click "Load unpacked" and choose the "homebox-extension" folder
     that came in this download.
  4. Click the Homebox icon in the toolbar → "Connect".
     A 4-digit code appears. Click "Approve" on the same code in the
     Homebox control panel.

STEP 3 — GIVE AN AI A TASK
  1. Open an AI chat site, e.g. https://lmarena.ai (use "Direct Chat"
     for full auto mode).
  2. Click the Homebox button at the bottom right of the page.
  3. Type your task, turn on "Auto-run", press "Start task".
  4. Approve changes when Homebox asks. Watch the files appear in your
     sandbox folder.

  Other AI site not in the list? Click the Homebox toolbar icon on that
  site → "Enable Homebox on this site".

  Arena "Battle" mode shows two answers side by side. Homebox then asks
  you to pick one ("Run (left)" / "Run (right)") instead of running both.


AI APPS WITH CONNECTORS (MCP)
  Apps that support custom MCP connectors can connect without the
  extension. The address is on the "Connect an AI" page of the panel.
  Web apps need the public link, which uses the free Cloudflare tool
  "cloudflared" (install it first).

NO EXTENSION? PASTE MODE
  The "Connect an AI" page also has a copy/paste mode that works with
  any chat, by hand.


SAFETY
  • AI only sees your sandbox folder. Secret files (.env, SSH keys,
    .pem/.key files…) are hidden even inside it.
  • Reading is automatic; changing files asks you; running commands is
    OFF unless you turn it on (then every command asks).
  • Every change is saved first — press Undo in the Activity page.
    There is no delete tool.
  • "Pause AI" or "Quit" in the panel cuts all access at once.
  • Everything AI reads is sent to that AI's company, like anything you
    paste into a chat. Don't put private documents in the sandbox.
  • Full log: .homebox/audit.jsonl in your home folder.

TROUBLESHOOTING
  • Extension says "app isn't running" → start Homebox, click Try again.
  • AI's actions aren't picked up → make sure the AI writes them in
    ```homebox code blocks. Say: "Use homebox blocks, as in my first
    message."
  • Results didn't send → they're in the chat box; press Send yourself.
  • Chat site changed its design and something stopped working → use
    the "Put in chat box" / "Copy" buttons, or Paste mode.
