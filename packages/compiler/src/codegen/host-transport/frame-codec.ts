export const SELECTED_HOST_FRAME_VERSION = 2;

export const SELECTED_HOST_FRAME_TAG = {
  exportInvocation: 0,
  exportCompletion: 1,
  effectRequest: 2,
  effectOutcome: 3,
  callbackInvocation: 4,
  callbackCompletion: 5,
  cancellation: 6,
  cancellationAcknowledgement: 7,
  vxCommand: 8,
  vxEvent: 9,
  vxExtensionRequest: 10,
  vxExtensionOutcome: 11,
  externalInvocation: 12,
  externalCompletion: 13,
} as const;
