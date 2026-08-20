'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, errorText } from '../_ui/api';
import { usePulse } from '../_ui/PulseProvider';
import { Err, Loading, ProjectSwitch } from '../_ui/bits';
import type { BrandProfile, Role } from '@/lib/pulse/types';

/**
 * Пространства, проекты, команда и бренд-контекст.
 *
 * Данные, шаблоны, токены и аналитика проектов не смешиваются —
 * это обеспечено политиками базы, а не порядком экранов.
 */

const ROLE_LABEL: Record<Role, string> = {
  owner: 'владелец',
  admin: 'админ',
  editor: 'редактор',
  approver: 'одобряет',
  analyst: 'аналитик',
  viewer: 'смотрит',
};

export default function ProjectsPage() {
  const { session, project, projectId, loading, reload } = usePulse();
  const [brand, setBrand] = useState<BrandProfile | null>(null);
  const [members, setMembers] = useState<Array<{ name: string; role: Role }>>([]);
  const [invite, setInvite] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [newProject, setNewProject] = useState('');

  const workspace = session?.workspaces.find((w) => w.id === project?.workspaceId) ?? null;

  const load = useCallback(async () => {
    if (!projectId) return;
    try {
      const overview = await api.get<{ brand: BrandProfile | null }>(
        `/api/pulse/projects/${projectId}`,
      );
      setBrand(overview.brand);
    } catch (e) {
      setFailure(errorText(e));
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!workspace) return;
    void api
      .get<Array<{ name: string; role: Role }>>(`/api/pulse/workspaces/${workspace.id}/members`)
      .then(setMembers)
      .catch(() => {});
  }, [workspace?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const saveBrand = async (patch: Partial<BrandProfile>) => {
    setBusy('brand');
    setFailure(null);
    try {
      setBrand(await api.patch<BrandProfile>(`/api/pulse/projects/${projectId}/brand`, patch));
    } catch (e) {
      setFailure(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const addProject = async () => {
    if (!workspace) return;
    setBusy('project');
    try {
      await api.post('/api/pulse/projects', { workspaceId: workspace.id, name: newProject });
      setNewProject('');
      await reload();
    } catch (e) {
      setFailure(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const makeInvite = async (role: Role) => {
    if (!workspace) return;
    setBusy('invite');
    try {
      const result = await api.post<{ code: string }>(
        `/api/pulse/workspaces/${workspace.id}/invitations`,
        { role },
      );
      setInvite(result.code);
    } catch (e) {
      setFailure(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  if (loading) return <Loading />;
  if (!session) return <div className="empty">Открой приложение внутри Telegram</div>;

  return (
    <div className="wrap">
      <header className="section">
        <h1 className="h2">Пространства</h1>
        <div className="stack" style={{ marginTop: 14 }}>
          {session.workspaces.map((w) => (
            <div className="row-between" key={w.id}>
              <span className="grow">{w.name}</span>
              <span className="tag">{ROLE_LABEL[w.role]}</span>
              <span className="mono dim">{w.projectCount} проектов</span>
            </div>
          ))}
        </div>
      </header>

      <section className="section stack">
        <p className="label">Проекты</p>
        <ProjectSwitch />
        <div className="row">
          <input
            className="field grow"
            value={newProject}
            onChange={(e) => setNewProject(e.target.value)}
            placeholder="Новый проект"
          />
          <button
            className="btn"
            disabled={busy === 'project' || newProject.trim().length < 2}
            onClick={() => void addProject()}
          >
            Добавить
          </button>
        </div>
      </section>

      <section className="section stack">
        <p className="label">Команда</p>
        {members.map((m, i) => (
          <div className="row-between" key={`${m.name}-${i}`}>
            <span className="grow">{m.name}</span>
            <span className="tag">{ROLE_LABEL[m.role]}</span>
          </div>
        ))}
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <button className="btn btn-small" disabled={busy === 'invite'} onClick={() => void makeInvite('editor')}>
            Позвать редактора
          </button>
          <button className="btn btn-small" disabled={busy === 'invite'} onClick={() => void makeInvite('approver')}>
            Позвать одобряющего
          </button>
        </div>
        {invite ? (
          <div className="card">
            <p className="label">код приглашения</p>
            <p className="display" style={{ fontSize: 32, marginTop: 6 }}>{invite}</p>
            <p className="mono dim" style={{ marginTop: 8 }}>Действует 14 дней, срабатывает один раз.</p>
          </div>
        ) : null}
      </section>

      {brand ? (
        <section className="section stack">
          <p className="label">Бренд-контекст — {project?.name}</p>
          <p className="mono dim">
            Это контекст, из которого собираются тексты. Данные одного проекта
            никогда не используются как контекст другого.
          </p>

          <label className="label" htmlFor="positioning">позиционирование</label>
          <textarea
            id="positioning"
            className="field"
            rows={3}
            defaultValue={brand.positioning}
            onBlur={(e) =>
              e.target.value !== brand.positioning && void saveBrand({ positioning: e.target.value })
            }
          />

          <label className="label" htmlFor="audiences">аудитория, через точку с запятой</label>
          <input
            id="audiences"
            className="field"
            defaultValue={brand.audiences.join('; ')}
            onBlur={(e) => void saveBrand({ audiences: split(e.target.value) })}
          />

          <label className="label" htmlFor="prohibited">запрещённые формулировки</label>
          <input
            id="prohibited"
            className="field"
            defaultValue={brand.prohibitedPhrases.join('; ')}
            onBlur={(e) => void saveBrand({ prohibitedPhrases: split(e.target.value) })}
          />

          <label className="label" htmlFor="facts">факты и цифры, через точку с запятой</label>
          <textarea
            id="facts"
            className="field"
            rows={3}
            defaultValue={brand.facts.map((f) => f.claim).join('; ')}
            onBlur={(e) =>
              void saveBrand({ facts: split(e.target.value).map((claim) => ({ claim })) })
            }
          />

          <label className="label" htmlFor="cta">основной призыв</label>
          <input
            id="cta"
            className="field"
            defaultValue={brand.defaultCta}
            onBlur={(e) =>
              e.target.value !== brand.defaultCta && void saveBrand({ defaultCta: e.target.value })
            }
          />

          {busy === 'brand' ? <p className="mono dim">Сохраняем…</p> : null}
        </section>
      ) : null}

      <section className="section">
        <Err text={failure} />
        <p className="mono dim">
          Тариф: {workspace?.plan ?? '—'} · часовой пояс проекта: {project?.timezone ?? '—'}
        </p>
      </section>
    </div>
  );
}

function split(value: string): string[] {
  return value
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}
