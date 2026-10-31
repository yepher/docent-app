import { contextBridge, ipcRenderer } from 'electron';
import type { Api } from '../shared/types';

function subscribe<T>(channel: string, cb: (value: T) => void) {
  const listener = (_e: unknown, value: T) => cb(value);
  ipcRenderer.on(channel, listener);
  return () => void ipcRenderer.off(channel, listener);
}

const api: Api = {
  runtime: {
    state: () => ipcRenderer.invoke('runtime:state'),
    install: () => ipcRenderer.invoke('runtime:install'),
    onState: (cb) => subscribe('runtime:state', cb),
  },
  sets: {
    list: () => ipcRenderer.invoke('sets:list'),
    create: (name) => ipcRenderer.invoke('sets:create', name),
    rename: (id, name) => ipcRenderer.invoke('sets:rename', id, name),
    remove: (id) => ipcRenderer.invoke('sets:remove', id),
    select: (id, selected) => ipcRenderer.invoke('sets:select', id, selected),
    addFiles: (id) => ipcRenderer.invoke('sets:addFiles', id),
    addFolder: (id) => ipcRenderer.invoke('sets:addFolder', id),
    rescan: (id) => ipcRenderer.invoke('sets:rescan', id),
    documents: (id) => ipcRenderer.invoke('sets:documents', id),
    removeDocument: (id) => ipcRenderer.invoke('sets:removeDocument', id),
    onProgress: (cb) => subscribe('sets:progress', cb),
  },
  chat: {
    send: (req) => ipcRenderer.invoke('chat:send', req),
    transcribe: (wav) => ipcRenderer.invoke('chat:transcribe', wav),
    cancel: (turnId) => ipcRenderer.invoke('chat:cancel', turnId),
    onEvent: (cb) => subscribe('chat:event', cb),
  },
  pronunciations: {
    list: () => ipcRenderer.invoke('pronunciations:list'),
    set: (word, spoken) => ipcRenderer.invoke('pronunciations:set', word, spoken),
    remove: (word) => ipcRenderer.invoke('pronunciations:remove', word),
    preview: (spoken) => ipcRenderer.invoke('pronunciations:preview', spoken),
  },
  docs: { open: (id) => ipcRenderer.invoke('docs:open', id) },
  update: {
    onState: (cb) => subscribe('update:state', cb),
    install: () => ipcRenderer.invoke('update:install'),
    openReleases: () => ipcRenderer.invoke('update:releases'),
  },
};

contextBridge.exposeInMainWorld('api', api);
