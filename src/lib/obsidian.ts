import { get, set } from 'idb-keyval';

export class ObsidianVault {
  dirHandle: FileSystemDirectoryHandle | null = null;
  templates: Record<string, string> = {};
  files: string[] = [];

  async connect() {
    try {
      this.dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
      await set('obsidian-vault-handle', this.dirHandle);
      await this.refresh();
      return true;
    } catch (e) {
      console.error(e);
      return false;
    }
  }

  async loadPersisted() {
    try {
      const handle = await get('obsidian-vault-handle');
      if (handle) {
        const permission = await this.verifyPermission(handle, true);
        if (permission) {
          this.dirHandle = handle as FileSystemDirectoryHandle;
          await this.refresh();
          return true;
        }
      }
    } catch (e) {
      console.error("Failed to load persisted handle:", e);
    }
    return false;
  }

  async verifyPermission(fileHandle: FileSystemHandle, readWrite: boolean) {
    const options: FileSystemHandlePermissionDescriptor = {};
    if (readWrite) {
      options.mode = 'readwrite';
    }
    if ((await fileHandle.queryPermission(options)) === 'granted') {
      return true;
    }
    if ((await fileHandle.requestPermission(options)) === 'granted') {
      return true;
    }
    return false;
  }

  async refresh() {
    if (!this.dirHandle) return;
    this.files = await this.getAllFiles(this.dirHandle);
    await this.loadTemplates();
  }

  async getAllFiles(dirHandle: FileSystemDirectoryHandle, path = ''): Promise<string[]> {
    let files: string[] = [];
    for await (const entry of dirHandle.values()) {
      if (entry.kind === 'file' && entry.name.endsWith('.md')) {
        files.push(`${path}${entry.name}`);
      } else if (entry.kind === 'directory' && !entry.name.startsWith('.')) {
        files.push(...await this.getAllFiles(entry, `${path}${entry.name}/`));
      }
    }
    return files;
  }

  async loadTemplates() {
    this.templates = {};
    const templateFiles = this.files.filter(f => f.startsWith('00_Templates/'));
    for (const file of templateFiles) {
      const content = await this.readFile(file);
      if (content !== null) {
        const name = file.replace('00_Templates/', '').replace('.md', '');
        this.templates[name] = content;
      }
    }
  }

  async readFile(path: string): Promise<string | null> {
    if (!this.dirHandle) return null;
    try {
      const parts = path.split('/');
      let currentHandle = this.dirHandle;
      for (let i = 0; i < parts.length - 1; i++) {
        currentHandle = await currentHandle.getDirectoryHandle(parts[i]);
      }
      const fileHandle = await currentHandle.getFileHandle(parts[parts.length - 1]);
      const file = await fileHandle.getFile();
      return await file.text();
    } catch (e) {
      console.error(`Error reading file ${path}:`, e);
      return null;
    }
  }

  async writeFile(path: string, content: string): Promise<boolean> {
    if (!this.dirHandle) return false;
    try {
      const parts = path.split('/');
      let currentHandle = this.dirHandle;
      for (let i = 0; i < parts.length - 1; i++) {
        currentHandle = await currentHandle.getDirectoryHandle(parts[i], { create: true });
      }
      const fileHandle = await currentHandle.getFileHandle(parts[parts.length - 1], { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(content);
      await writable.close();
      
      if (!this.files.includes(path)) {
        this.files.push(path);
      }
      return true;
    } catch (e) {
      console.error(`Error writing file ${path}:`, e);
      return false;
    }
  }
}

export const vault = new ObsidianVault();
