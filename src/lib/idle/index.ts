/** 閒置自動登出純邏輯層 barrel（spec 02 §5.5.2）。 */
export {
  createIdleTimer,
  MAX_SAFE_TIMEOUT,
  type IdleTimerEvent,
  type IdleTimerDeps,
  type IdleTimerOpts,
  type IdleTimerHandle,
} from './idle-timer';
export {
  createAuthChannel,
  type AuthChannelMessage,
  type AuthChannelOpts,
  type AuthChannelHandle,
} from './auth-channel';
export { idlePolicyFor, type IdlePolicy } from './idle-config';
