'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, errorText } from './api';
import type { Me, Project, Workspace } from '@/lib/pulse/types';

/**
 * Общее состояние оболочки: кто вошёл, какие пространства и проекты,
 * какой проект выбран сейчас. Переключатель проекта живёт здесь, чтобы
 * каждый экран не тащил его заново.
 */

type Session = {
  me: Me;
  workspaces: Workspace[];
  projects: Project[];
  aiConnected: boolean;
};

type Ctx = {
  session: Session | null;
  loading: boolean;
  error: string | null;
  project: Project | null;
  projectId: string | null;
  setProjectId(id: string): void;
  reload(): Promise<void>;
};

const PulseContext = createContext<Ctx | null>(null);

const STORAGE_KEY = 'pulse.project';

export function PulseProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [projectId, setProjectIdState] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setError(null);
    try {
      const next = await api.post<Session>('/api/pulse/session');
      setSession(next);
      setProjectIdState((current) => {
        if (current && next.projects.some((p) => p.id === current)) return current;
        const stored = read();
        if (stored && next.projects.some((p) => p.id === stored)) return stored;
        return next.projects[0]?.id ?? null;
      });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const setProjectId = useCallback((id: string) => {
    setProjectIdState(id);
    write(id);
  }, []);

  const value = useMemo<Ctx>(
    () => ({
      session,
      loading,
      error,
      projectId,
      project: session?.projects.find((p) => p.id === projectId) ?? null,
      setProjectId,
      reload,
    }),
    [session, loading, error, projectId, setProjectId, reload],
  );

  return <PulseContext.Provider value={value}>{children}</PulseContext.Provider>;
}

export function usePulse(): Ctx {
  const ctx = useContext(PulseContext);
  if (!ctx) throw new Error('usePulse вне PulseProvider');
  return ctx;
}

function read(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function write(id: string): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // приватный режим — переключатель просто не запомнится
  }
}
