import { homedir } from "os";
import { join } from "path";
import { GitKnowledgeStore } from "./git-store";
import { HybridSearchEngine } from "./search";
import { LocalStorage } from "./storage";

export interface PluginContext {
  gitStore: GitKnowledgeStore;
  localStorage: LocalStorage;
  searchEngine: HybridSearchEngine;
}

let instance: PluginContext | null = null;

export function getPluginContext(cwd: string): PluginContext {
  if (!instance) {
    const gitStore = new GitKnowledgeStore(cwd);
    const dbPath = join(homedir(), ".claude", "engram", "local.db");
    const localStorage = new LocalStorage(dbPath);
    const searchEngine = new HybridSearchEngine(gitStore, localStorage);
    instance = { gitStore, localStorage, searchEngine };
  }
  return instance;
}
