// Show the extension version in the popup directly from the manifest,
// so the label can never disagree with the shipped build.
(function () {
  const pill = document.getElementById('versionPill');
  if (!pill) return;
  try {
    const version = chrome.runtime.getManifest().version;
    if (version) pill.textContent = 'v' + version;
  } catch (error) {
    // Manifest access should never break the popup; leave the HTML placeholder.
  }
})();
