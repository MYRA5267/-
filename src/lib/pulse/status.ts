import type { ContentStatus, ErrorStatus, VariantStatus } from './types';

/**
 * Статусная модель материала. Держим её здесь одной таблицей, а не
 * россыпью проверок по роутам: правило «правка после одобрения сбрасывает
 * в review» должно быть в одном месте, иначе однажды его забудут.
 */
const ALLOWED: Record<ContentStatus, ContentStatus[]> = {
  IDEA: ['DRAFT'],
  DRAFT: ['IN_REVIEW', 'DRAFT'],
  IN_REVIEW: ['APPROVED', 'CHANGES_REQUESTED', 'DRAFT'],
  CHANGES_REQUESTED: ['DRAFT', 'IN_REVIEW'],
  // из APPROVED назад в DRAFT — это и есть сброс после правки
  APPROVED: ['SCHEDULED', 'DRAFT'],
  SCHEDULED: ['PUBLISHING', 'APPROVED', 'DRAFT'],
  PUBLISHING: ['PUBLISHED'],
  PUBLISHED: ['MEASURING'],
  MEASURING: ['ANALYZED', 'MEASURING'],
  ANALYZED: ['ANALYZED'],
};

const ERROR_SET = new Set<string>([
  'AUTH_REQUIRED',
  'MEDIA_INVALID',
  'PLATFORM_REJECTED',
  'RATE_LIMITED',
  'FAILED_RETRYABLE',
  'FAILED_FINAL',
]);

export function isErrorStatus(status: VariantStatus): status is ErrorStatus {
  return ERROR_SET.has(status);
}

export function canTransition(from: VariantStatus, to: VariantStatus): boolean {
  // в ошибку можно свалиться из любого рабочего состояния
  if (isErrorStatus(to)) return !isErrorStatus(from) || to === 'FAILED_FINAL';
  // из ошибки возвращаемся руками — в черновик или обратно в очередь
  if (isErrorStatus(from)) return to === 'DRAFT' || to === 'SCHEDULED' || to === 'PUBLISHING';
  return ALLOWED[from]?.includes(to) ?? false;
}

/** Бросает, если переход не разрешён: вызывающему не нужно помнить таблицу. */
export function assertTransition(from: VariantStatus, to: VariantStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`Недопустимый переход статуса: ${from} → ${to}`);
  }
}

/** Правка текста после одобрения обязана снять одобрение. Правило 3 из ТЗ. */
export function statusAfterEdit(current: VariantStatus): VariantStatus {
  if (current === 'APPROVED' || current === 'SCHEDULED' || current === 'IN_REVIEW') return 'DRAFT';
  if (isErrorStatus(current)) return 'DRAFT';
  if (current === 'CHANGES_REQUESTED') return 'DRAFT';
  return current;
}

/**
 * Версию ещё можно править руками.
 *
 * Опубликованное не правят: в канале уже висит текст, и расхождение
 * записи с реальностью хуже, чем запрет.
 */
export function isEditable(status: VariantStatus): boolean {
  return (
    status !== 'PUBLISHING' &&
    status !== 'PUBLISHED' &&
    status !== 'MEASURING' &&
    status !== 'ANALYZED'
  );
}

/**
 * Поверх этой версии можно сгенерировать заново.
 *
 * Одобренное и ушедшее в очередь перегенерацией не трогаем: там уже
 * висит решение человека.
 */
export function isRegeneratable(status: VariantStatus): boolean {
  return status === 'DRAFT' || status === 'IN_REVIEW' || status === 'CHANGES_REQUESTED';
}

/** Материал ещё живёт в производстве, а не в аналитике. */
export function isInProduction(status: VariantStatus): boolean {
  return (
    status === 'IDEA' ||
    status === 'DRAFT' ||
    status === 'IN_REVIEW' ||
    status === 'CHANGES_REQUESTED' ||
    status === 'APPROVED'
  );
}

export const STATUS_LABEL: Record<string, string> = {
  IDEA: 'идея',
  DRAFT: 'черновик',
  IN_REVIEW: 'на согласовании',
  CHANGES_REQUESTED: 'вернули',
  APPROVED: 'одобрено',
  SCHEDULED: 'в очереди',
  PUBLISHING: 'отправляется',
  PUBLISHED: 'опубликовано',
  MEASURING: 'считаем',
  ANALYZED: 'разобрано',
  AUTH_REQUIRED: 'нужен доступ',
  MEDIA_INVALID: 'медиа не принято',
  PLATFORM_REJECTED: 'площадка отказала',
  RATE_LIMITED: 'лимит площадки',
  FAILED_RETRYABLE: 'повторим',
  FAILED_FINAL: 'остановлено',
};
