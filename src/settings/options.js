/* Verbatim settings page: choose, re-approve, test or clear the save folder. */
(function () {
  const F = globalThis.Verbatim.saveFolder;
  const $ = (id) => document.getElementById(id);

  function say(text) {
    $('message').textContent = text;
  }

  async function render() {
    const handle = await F.getFolder();
    const state = handle ? await F.permission(handle) : null;
    $('dot').className = 'dot ' + (!handle ? '' : state === 'granted' ? 'ok' : 'warn');
    $('current').textContent = !handle
      ? 'Downloads/Verbatim (no folder chosen)'
      : state === 'granted'
        ? `“${handle.name}”: ready`
        : `“${handle.name}”: Chrome needs your OK again. Until then, captures go to Downloads/Verbatim.`;
    $('choose').textContent = handle ? 'Choose a different folder…' : 'Choose folder…';
    $('approve').hidden = !handle || state === 'granted';
    $('test').hidden = !handle || state !== 'granted';
    $('reset').hidden = !handle;
  }

  $('choose').addEventListener('click', async () => {
    try {
      const handle = await window.showDirectoryPicker({ id: 'verbatim-save-folder', mode: 'readwrite' });
      await F.setFolder(handle);
      say(`Captures will be saved to “${handle.name}”. If Chrome later asks again, choose “Allow on every visit” so it remembers.`);
    } catch (err) {
      if (err.name !== 'AbortError') say(`Couldn't use that folder: ${err.message}`);
    }
    render();
  });

  $('approve').addEventListener('click', async () => {
    const handle = await F.getFolder();
    const state = handle && (await handle.requestPermission({ mode: 'readwrite' }));
    say(state === 'granted' ? 'Access allowed. Captures will be saved there again. (If Chrome offered “Allow on every visit”, it won’t ask again.)' : 'Access was not allowed.');
    render();
  });

  $('test').addEventListener('click', async () => {
    const handle = await F.getFolder();
    try {
      const name = 'Verbatim test — you can delete this.md';
      const file = await handle.getFileHandle(name, { create: true });
      const w = await file.createWritable();
      await w.write(`Verbatim can save to this folder. (${new Date().toLocaleString()})\n`);
      await w.close();
      await handle.removeEntry(name);
      say(`Test passed: Verbatim wrote to “${handle.name}” and cleaned up after itself.`);
    } catch (err) {
      say(`Test failed: ${err.message}`);
    }
  });

  $('reset').addEventListener('click', async () => {
    await F.clearFolder();
    say('Captures will be saved to Downloads/Verbatim.');
    render();
  });

  render();
})();
