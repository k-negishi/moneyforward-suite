// 認証セッション管理と allow-list ロガー（ADR-0011〜ADR-0017）を置く。
export type {
  LogSink,
  StructuredLogRecord,
  StructuredLoggerOptions,
} from './logging/structured-logger.js'
export { createStructuredLogger } from './logging/structured-logger.js'

export type {
  SessionCookie,
  SessionOrigin,
  SessionState,
  SessionStorageEntry,
} from './session/session-state.js'
export type { SessionLoadResult } from './session/session-file.js'
export { readSessionFile, saveSessionState } from './session/session-file.js'
export {
  SESSION_FILE_ENV_VAR,
  formatSessionPathForDisplay,
  resolveSessionFilePath,
} from './session/session-path.js'
export { fromAuthSession, toAuthSession } from './session/auth-session.js'
