const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sundial', {
  getSettings: function() {
    return ipcRenderer.invoke('get-settings');
  },
  saveSettings: function(data) {
    ipcRenderer.send('save-settings', data);
  },
  onSettingsSaved: function(callback) {
    ipcRenderer.on('settings-saved', callback);
  }
});
