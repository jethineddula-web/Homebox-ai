// Setup guides for every app, shown on the Maya page and in each app's panel on the Apps page.
// Each step: t = what to do, d = details (HTML), code = a line to copy, ok = how you know it worked.
// fixes: [problem, what to do]. `a` is the app's info from the Homebox app.
window.HB_GUIDES = (() => {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const turnOn = name => ({ t: `Turn on "Let AI control ${name}"`, d: `Use the "Let AI control ${name}" switch on this page. The AI still has to ask before every step, unless you turn on Full access.` });
  const newChat = (example) => ({ t: 'Start a new chat on your AI site', d: `The AI only learns which apps it can use at the start of a chat. Open ChatGPT, Claude or another AI site in a <b>new chat</b>, click the round <b>Homebox</b> button and type a task, for example: <i>"${esc(example)}"</i>.` });
  const test = (name) => ({ t: 'Click "Test connection"', d: 'The button is next to the status at the top of this page.', ok: `The status turns green and shows "Connected" with your ${esc(name)} version.` });
  const listening = (name, port) => `${name} prints <code>Homebox: ${name} is listening on port ${port}</code>.`;

  const G = {
    maya: a => ({
      steps: [
        turnOn('Maya'),
        { t: 'Turn on "Start with Maya automatically" (recommended)', d: `Homebox adds a short, clearly marked block to your Maya startup file:<br><code>${esc(a.userSetup)}</code><br>It starts the secure Homebox bridge every time Maya opens. Your own lines in that file are not touched.` },
        { t: 'Restart Maya', d: 'Close Maya completely and open it again.', ok: 'Open the Script Editor (<b>Windows → General Editors → Script Editor</b>). The top half shows <code>Homebox: Maya is listening on port 7017</code>.' },
        { t: 'Or, just for this session: paste one line', d: 'In Maya open <b>Windows → General Editors → Script Editor</b>. In the bottom half, click the <b>Python</b> tab (no Python tab? click <b>+</b> and choose Python). Paste this line and press <kbd>Ctrl</kbd>+<kbd>Enter</kbd>:', code: a.setupLine, ok: 'The top half of the Script Editor shows <code>Homebox: Maya is listening on port 7017</code>.' },
        test('Maya'),
        newChat('In Maya, build a simple wooden table with four legs, grouped as table_grp'),
      ],
      fixes: [
        ['"Maya is not connected"', 'Maya must be open. If you just turned on automatic start, restart Maya once. Otherwise paste the setup line again: it lasts until Maya closes.'],
        ['"did not answer in time"', 'A dialog box is probably open in Maya (for example Save or a warning). Close it and approve the step again. Very heavy steps can also take a while.'],
        ['"port 7017 is busy" in the Script Editor', 'The bridge is already running (that is fine), or another program uses the port. Restart Maya.'],
        ['The AI says it cannot use Maya', 'Turn on "Let AI control Maya", then start a new chat.'],
      ],
    }),
    blender: a => ({
      steps: [
        turnOn('Blender'),
        { t: 'Open Blender and go to the Scripting tab', d: 'Click <b>Scripting</b> in the row of tabs at the very top of the Blender window. The <b>Python Console</b> is the panel with <code>&gt;&gt;&gt;</code>.' },
        { t: 'Paste this line into the Python Console and press Enter', code: a.setupLine, ok: `The console (or Window → Toggle System Console) shows <code>Homebox: Blender is listening on port 7010</code>.` },
        test('Blender'),
        { t: 'Optional: start it automatically', d: `Turn on <b>Start automatically</b> above (Blender must have been opened once). Or install it as an add-on: <b>Edit → Preferences → Add-ons</b>, click the <b>˅</b> menu at the top right, <b>Install from Disk…</b>, pick this file and tick <b>Homebox bridge</b>:<br><code>${esc(a.bridgeFile)}</code>` },
        newChat('In Blender, model a low-poly campfire with stones around it'),
      ],
      fixes: [
        ['"Blender is not listening"', 'Paste the line again after every Blender restart, or turn on Start automatically.'],
        ['A step fails with a "context" error', 'Tell the AI: "use bpy.data instead of bpy.ops for that step".'],
        ['Blender freezes for a moment', 'Normal for heavy steps such as subdivision or baking. Ask for lower detail while blocking out.'],
      ],
    }),
    houdini: a => ({
      steps: [
        turnOn('Houdini'),
        { t: 'Open the Python Shell', d: 'In Houdini choose <b>Windows → Python Shell</b>.' },
        { t: 'Paste this line and press Enter', code: a.setupLine, ok: listening('Houdini', 7011).replace('Houdini prints', 'The Python Shell prints') },
        test('Houdini'),
        { t: 'Optional: start it automatically', d: 'Turn on <b>Start automatically</b> above. Homebox adds a marked block to <code>Documents\\houdiniXX.X\\scripts\\456.py</code> for each Houdini version you have opened. The bridge starts once per session.' },
        newChat('In Houdini, make a geo node with a box and a subdivide SOP, then lay out the nodes'),
      ],
      fixes: [
        ['"Houdini is not listening"', 'Paste the line again, or turn on Start automatically and reopen a scene.'],
        ['"no Qt found"', 'Run it in Houdini with its normal window, not in hython or a terminal.'],
        ['Start automatically is greyed out', 'Open Houdini once so its Documents folder exists, then come back.'],
      ],
    }),
    max: a => ({
      steps: [
        turnOn('3ds Max'),
        { t: 'Open the Scripting Listener in Python mode', d: 'Needs 3ds Max 2022 or newer. Choose <b>Scripting → Scripting Listener</b> (or press <kbd>F11</kbd>). At the bottom-left of the Listener, switch the language from <b>MAXScript</b> to <b>Python</b>.' },
        { t: 'Paste this line and press Enter', code: a.setupLine, ok: listening('3ds Max', 7012).replace('3ds Max prints', 'The Listener prints') },
        test('3ds Max'),
        { t: 'Optional: start it automatically', d: 'Turn on <b>Start automatically</b> above. Homebox adds a small start file to 3ds Max\'s user startup-scripts folder.' },
        newChat('In 3ds Max, create a staircase of 10 boxes, each 20 cm higher than the last'),
      ],
      fixes: [
        ['No Python option in the Listener', 'Your 3ds Max is older than 2022. Homebox needs 3ds Max 2022 or newer.'],
        ['"3ds Max is not listening"', 'Paste the line again, or turn on Start automatically and restart 3ds Max.'],
      ],
    }),
    c4d: a => ({
      steps: [
        turnOn('Cinema 4D'),
        { t: 'Add the Homebox plugin folder', d: 'Needs Cinema 4D 2023 or newer. Choose <b>Edit → Preferences → Plugins</b>, click <b>Add Folder…</b> and choose this folder:', code: a.c4dFolder },
        { t: 'Restart Cinema 4D', ok: 'Open <b>Extensions → Console</b>. It shows <code>Homebox: Cinema 4D is listening on port 7013</code>.' },
        test('Cinema 4D'),
        newChat('In Cinema 4D, make a cloner with 25 spheres in a grid'),
      ],
      fixes: [
        ['Nothing in the Console after restart', 'Check that the folder above is listed under Preferences → Plugins, exactly as shown.'],
        ['Undo doesn\'t remove what the AI made', 'Ask the AI to call doc.AddUndo after each new object.'],
      ],
    }),
    nuke: a => ({
      steps: [
        turnOn('Nuke'),
        { t: 'Open the Script Editor', d: 'In Nuke, open any panel\'s content menu and choose <b>Windows → Script Editor</b>.' },
        { t: 'Paste this line into the bottom half and press Ctrl+Enter', code: a.setupLine, ok: listening('Nuke', 7014).replace('Nuke prints', 'The top half prints') },
        test('Nuke'),
        { t: 'Optional: start it automatically', d: 'Turn on <b>Start automatically</b> above. Homebox adds a marked block to your <code>.nuke\\menu.py</code>.' },
        newChat('In Nuke, add a Read node, a Grade and a Write node, connected in order'),
      ],
      fixes: [
        ['"Nuke is not listening"', 'Paste the line again, or turn on Start automatically and restart Nuke.'],
        ['Nothing happens', 'Run Nuke with its normal window, not in terminal mode.'],
      ],
    }),
    unreal: a => ({
      steps: [
        turnOn('Unreal Engine'),
        { t: 'Enable Python in your project (once)', d: 'In the Unreal Editor choose <b>Edit → Plugins</b>, search for <b>Python Editor Script Plugin</b>, tick <b>Enabled</b> and restart the editor.' },
        { t: 'Open the Output Log in Python mode', d: 'Choose <b>Window → Output Log</b>. At the bottom, click the <b>Cmd</b> drop-down and pick <b>Python</b>.' },
        { t: 'Paste this line and press Enter', code: a.setupLine, ok: listening('Unreal Engine', 7015).replace('Unreal Engine prints', 'The Output Log prints') },
        test('Unreal Engine'),
        { t: 'Optional: start it with this project every time', d: 'Choose <b>Edit → Project Settings → Plugins → Python</b>. Under <b>Startup Scripts</b> click <b>+</b> and paste:', code: a.bridgeFile },
        newChat('In Unreal, place a point light 3 m above the origin and name it KeyLight'),
      ],
      fixes: [
        ['No "Python" in the Cmd drop-down', 'The Python Editor Script Plugin is not enabled yet (step 2).'],
        ['Works in one project but not another', 'Each project needs the plugin, and its own startup-script entry.'],
      ],
    }),
    painter: a => ({
      steps: [
        turnOn('Substance 3D Painter'),
        { t: 'Turn on "Start automatically"', d: 'Open Painter once first so its Documents folder exists. Homebox then copies its bridge into Painter\'s <code>python\\startup</code> folder.' },
        { t: 'Restart Painter', d: 'Or choose <b>Python → Reload Plugins Folder</b>.', ok: 'The log (<b>Window → Views → Log</b>) shows <code>Homebox: Substance 3D Painter is listening on port 7016</code>.' },
        test('Substance 3D Painter'),
        newChat('In Painter, list the texture sets of the open project'),
      ],
      fixes: [
        ['Start automatically is greyed out', 'Open Substance 3D Painter once, then come back.'],
        ['"not listening"', 'Restart Painter, or use Python → Reload Plugins Folder.'],
      ],
    }),
    photoshop: () => ({
      steps: [
        turnOn('Photoshop'),
        { t: 'Open Photoshop and leave it open', d: 'Any recent version works. Nothing needs to be installed: Homebox talks to Photoshop through Windows.' },
        test('Photoshop'),
        newChat('In Photoshop, make a 1080×1080 post with a dark blue background and the title "Summer Sale"'),
      ],
      fixes: [
        ['"Photoshop is not open"', 'Open Photoshop, wait until it has finished starting, then test again.'],
        ['A step fails or hangs', 'Close any open dialog box in Photoshop (New Document, Save, warnings). Scripts wait for dialogs.'],
        ['Undo', 'When a document is open, each AI step is one History step. Press Ctrl+Z in Photoshop.'],
      ],
    }),
    illustrator: () => ({
      steps: [
        turnOn('Illustrator'),
        { t: 'Open Illustrator and leave it open', d: 'Nothing needs to be installed: Homebox talks to Illustrator through Windows.' },
        test('Illustrator'),
        newChat('In Illustrator, draw a simple logo: a green circle with the letter H in the middle'),
      ],
      fixes: [
        ['"Illustrator is not open"', 'Open Illustrator, wait until it has finished starting, then test again.'],
        ['A step fails or hangs', 'Close any open dialog box in Illustrator and approve the step again.'],
      ],
    }),
    aftereffects: () => ({
      steps: [
        turnOn('After Effects'),
        { t: 'Open After Effects', d: 'Homebox finds After Effects in Program Files automatically.' },
        { t: 'Allow scripts to write files (once)', d: 'Choose <b>Edit → Preferences → Scripting &amp; Expressions</b>, tick <b>Allow Scripts to Write Files and Access Network</b> and click OK. Homebox reads each step\'s result through a small file.' },
        test('After Effects'),
        newChat('In After Effects, make a 10-second 1080p comp with a title that slides in from the left'),
      ],
      fixes: [
        ['"did not answer in time"', 'Check the preference in step 3, and close any dialog box in After Effects.'],
        ['"not found in Program Files"', 'After Effects is installed in an unusual place. Reinstall it to the default location.'],
      ],
    }),
    excel: () => ({
      steps: [
        turnOn('Excel'),
        { t: 'Open Excel with your workbook and save it', d: '<b>Save first:</b> Excel cannot undo changes made by scripts. Working on a copy is even safer.' },
        test('Excel'),
        newChat('In Excel, add a Total column (Quantity × Price) and a sum at the bottom'),
      ],
      fixes: [
        ['"Could not reach Excel"', 'A cell is being edited or a dialog is open. Press Esc in Excel and try again.'],
        ['Several Excel windows are open', 'Homebox uses the first Excel window that was opened. Close the others.'],
      ],
    }),
    word: () => ({
      steps: [
        turnOn('Word'),
        { t: 'Open Word with your document', d: 'Each AI step is one Undo in Word (Ctrl+Z).' },
        test('Word'),
        newChat('In Word, write a one-page meeting summary with a title and three headings'),
      ],
      fixes: [['"Could not reach Word"', 'Close any open dialog box in Word and try again.']],
    }),
    powerpoint: () => ({
      steps: [
        turnOn('PowerPoint'),
        { t: 'Open PowerPoint and save your presentation', d: '<b>Save first:</b> PowerPoint cannot undo changes made by scripts.' },
        test('PowerPoint'),
        newChat('In PowerPoint, make a 5-slide deck about our Q3 plan with a title slide'),
      ],
      fixes: [['"Could not reach PowerPoint"', 'Close any open dialog box in PowerPoint and try again.']],
    }),
    autocad: () => ({
      steps: [
        turnOn('AutoCAD'),
        { t: 'Open AutoCAD with a drawing', d: 'Needs full AutoCAD (or a vertical such as Architecture). AutoCAD LT has no automation support.' },
        test('AutoCAD'),
        newChat('In AutoCAD, draw a 5000 × 3000 rectangle with a 900 wide door opening on the bottom side'),
      ],
      fixes: [
        ['"AutoCAD is not open"', 'Open AutoCAD and a drawing, then test again.'],
        ['"Could not reach AutoCAD"', 'Finish or cancel the current command (press Esc) and try again.'],
      ],
    }),
    vscode: () => ({
      steps: [
        turnOn('VS Code'),
        { t: 'Turn on "Install the Homebox extension in VS Code"', d: 'Use the switch at the top of this panel. Homebox builds its small VS Code extension and installs it with VS Code\'s own installer. This takes a few seconds.' },
        { t: 'Reload VS Code', d: 'Close VS Code and open it again, or press <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd> and run <b>Developer: Reload Window</b>.', ok: 'A <b>Homebox</b> item with a house icon appears at the bottom right of VS Code\'s status bar.' },
        { t: 'Open your project and make it the sandbox', d: 'In VS Code, open your project folder (<b>File → Open Folder</b>). Then click the <b>Homebox</b> item in the status bar and choose <b>Use this folder as the AI sandbox</b>. You can also run <b>Homebox: Use This Folder as the AI Sandbox</b> from <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd>.', ok: 'Homebox → <b>Folders</b> shows your project as the <b>Active</b> folder.' },
        test('VS Code'),
        newChat('Look at the errors VS Code shows in my project, fix them, then open the files you changed'),
      ],
      fixes: [
        ['"VS Code is not connected"', 'Reload VS Code after installing the extension (step 3). Check that the Homebox item shows in the status bar.'],
        ['"sandbox folder not open there"', 'VS Code is connected, but it has a different folder open. Open your sandbox folder in VS Code, or use step 4 to make VS Code\'s folder the sandbox.'],
        ['The install switch is greyed out', 'Homebox could not find VS Code. Install VS Code from code.visualstudio.com and come back.'],
        ['The AI changed a file I was editing', 'Save your files before starting a task. The AI is told to check for unsaved files and ask you first. Every change can be undone on the Activity page.'],
        ['Switching between projects', 'Every VS Code window shows Homebox in its status bar. The window the AI works in says <b>AI works here</b>; the others say <b>Use this folder</b>. Click it in the window you want and the AI moves there. Folders you used before switch without asking. Start a new chat for a new project.'],
        ['Homebox is missing in a window', 'Reload that window: <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd> → <b>Developer: Reload Window</b>. Homebox also works in Restricted Mode, in folders you haven\'t marked as trusted.'],
      ],
    }),
    github: () => ({
      steps: [
        turnOn('GitHub'),
        { t: 'Install Git (if you don\'t have it)', d: 'Open <b>Terminal</b> or <b>PowerShell</b> from the Start menu, paste this line and press Enter. Or download it from git-scm.com.', code: 'winget install --id Git.Git -e', ok: '<code>git --version</code> prints a version number.' },
        { t: 'Install the GitHub CLI', d: 'In the same window, paste this line and press Enter:', code: 'winget install --id GitHub.cli -e' },
        { t: 'Sign in to GitHub', d: 'Close and reopen the terminal, then run the line below. Choose <b>GitHub.com</b>, <b>HTTPS</b>, <b>Yes</b> to use it for git, and <b>Login with a web browser</b>. Type the code it shows into the page that opens. Your password stays between you and GitHub: Homebox never sees it.', code: 'gh auth login' },
        { ...test('GitHub'), ok: 'The status turns green and says <b>signed in as</b> your GitHub name.' },
        newChat('Plan 5 GitHub portfolio projects that fit my skills, then build the first one in projects/ with a README, and publish it'),
      ],
      fixes: [
        ['"Git is not installed" right after installing it', 'Quit Homebox (Settings → Quit Homebox) and start it again, so it sees the new programs.'],
        ['"You are not signed in to GitHub"', 'Run <code>gh auth login</code> again (step 4), then click Test connection.'],
        ['"must never be published" or "personal documents"', 'Homebox found keys, passwords or a CV inside the project folder. Move them out of the folder. Your CV belongs in the files folder, not in a project.'],
        ['"name already exists on this account"', 'Pick a different repository name, or delete the old repository on github.com first.'],
      ],
    }),
    obs: () => ({
      steps: [
        turnOn('OBS Studio'),
        { t: 'Open the WebSocket settings in OBS', d: 'Needs OBS Studio 28 or newer. Choose <b>Tools → WebSocket Server Settings</b>.' },
        { t: 'Turn the server on', d: 'Tick <b>Enable WebSocket server</b>. Keep <b>Enable Authentication</b> ticked, and click <b>Apply</b>.' },
        { t: 'Copy the password into Homebox', d: 'Click <b>Show Connect Info</b>, copy the <b>Server Password</b>, paste it in the box below and click <b>Save</b>. Homebox tests the connection straight away.', ok: 'The status turns green and shows your OBS version.' },
        newChat('In OBS, list my scenes, then switch to the one called Live'),
      ],
      fixes: [
        ['"OBS rejected the password"', 'Copy it again from Show Connect Info. It changes if you click Generate Password.'],
        ['"OBS is not reachable"', 'OBS is closed, or the WebSocket server is off (step 3).'],
      ],
    }),
  };

  function render(id, a) {
    const g = G[id] && G[id](a);
    if (!g) return '';
    const steps = g.steps.map((s, i) => {
      const cid = `g-${id}-${i}`;
      return `<li><b>${s.t}</b>${s.d ? `<div class="g-d">${s.d}</div>` : ''}
        ${s.code ? `<div class="codeblock"><code id="${cid}">${esc(s.code)}</code><button class="btn small" data-copy-from="${cid}"><svg><use href="#i-copy"/></svg>Copy</button></div>` : ''}
        ${s.ok ? `<div class="g-ok"><svg><use href="#i-check"/></svg><span><b>You'll know it worked when:</b> ${s.ok}</span></div>` : ''}</li>`;
    }).join('');
    const fixes = g.fixes && g.fixes.length ? `<details class="g-fix"><summary>If it doesn't work</summary><dl>${g.fixes.map(([p, f]) => `<dt>${p}</dt><dd>${f}</dd>`).join('')}</dl></details>` : '';
    return `<ol class="howto guide-steps">${steps}</ol>${fixes}`;
  }
  return { render };
})();
