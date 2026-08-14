'use client';

import type { EyeState } from '@/lib/pulse/types';

/**
 * Глаз PULSE.
 *
 * Не украшение: показывает состояние системы, и состояние берётся из
 * реальной очереди, а не проигрывается случайно.
 *
 * Здесь векторная версия — она весит килобайты, работает на слабых
 * устройствах и уважает prefers-reduced-motion. GLB + React Three Fiber
 * с Draco-сжатием — следующий шаг, интерфейс к нему уже готов: состояние
 * приходит одним значением.
 */

const CAPTION: Record<EyeState, string> = {
  breathing: 'всё обработано',
  focusing: 'идёт генерация',
  watching: 'ждёт решения',
  ringed: 'публикация запланирована',
  flash: 'публикация отправлена',
  torn: 'ошибка подключения',
  closed: 'срочных задач нет',
};

export function Eye({ state }: { state: EyeState }) {
  return (
    <div>
      <svg
        className="eye"
        data-state={state}
        viewBox="0 0 128 128"
        role="img"
        aria-label={`Состояние системы: ${CAPTION[state]}`}
      >
        {/* контур: рвётся красным, когда отвалилось подключение */}
        <circle
          className="eye-outline"
          cx="64"
          cy="64"
          r="58"
          fill="none"
          stroke="#1f1f22"
          strokeWidth="1.5"
        />

        {/* тонкое оранжевое кольцо — в очереди есть публикация */}
        <circle
          className="eye-ring"
          cx="64"
          cy="64"
          r="50"
          fill="none"
          stroke="#FF4A1C"
          strokeWidth="1.5"
          strokeDasharray="90 220"
          opacity="0"
          style={{ transformOrigin: 'center' }}
        />

        <g className="eye-iris">
          <circle cx="64" cy="64" r="30" fill="none" stroke="#F2F0EA" strokeWidth="1.5" />
          <circle cx="64" cy="64" r="22" fill="none" stroke="#6B6B6E" strokeWidth="1" />
          <circle className="eye-pupil" cx="64" cy="64" r="13" fill="#F2F0EA" />
          {/* блик: единственная мягкая деталь на всём экране */}
          <circle cx="57" cy="57" r="4" fill="#0B0B0C" opacity="0.85" />
        </g>

        <circle className="eye-flash" cx="64" cy="64" r="58" fill="#F2F0EA" opacity="0" />

        {/* веко закрывается, когда делать нечего */}
        <rect className="eye-lid" x="0" y="0" width="128" height="128" fill="#0B0B0C" />
      </svg>

      <p className="label" style={{ textAlign: 'center', marginTop: 12 }}>
        {CAPTION[state]}
      </p>
    </div>
  );
}
