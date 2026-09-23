/** Result returned by a composition validation pass. */
export type TransactionValidation = {
  acceptable: boolean;
  reasons?: string[];
};

export type RepresentationTransaction<TState, TPlan = unknown> = {
  currentState: TState;
  plan: TPlan;
  cloneCurrentState: (state: TState) => TState;
  removeOriginalRegion: (trial: TState, plan: TPlan) => void;
  addRepresentation: (trial: TState, plan: TPlan) => void;
  validate: (trial: TState, plan: TPlan) => TransactionValidation;
  commit?: (trial: TState) => void;
};

export type TransactionResult<TState> = {
  committed: boolean;
  state: TState;
  originalPreserved: boolean;
  validation: TransactionValidation;
};

/**
 * Apply a representation against a clone. A failed validation returns the
 * untouched state, making replacement failure unable to erase the source
 * geometry. The helper is deliberately generic so the brick engine can adopt
 * it without coupling scene planning to a particular model type.
 */
export function applyRepresentationTransaction<TState, TPlan>(
  transaction: RepresentationTransaction<TState, TPlan>,
): TransactionResult<TState> {
  const trial = transaction.cloneCurrentState(transaction.currentState);
  try {
    transaction.removeOriginalRegion(trial, transaction.plan);
    transaction.addRepresentation(trial, transaction.plan);
    const validation = transaction.validate(trial, transaction.plan);
    if (!validation.acceptable)
      return {
        committed: false,
        state: transaction.currentState,
        originalPreserved: true,
        validation,
      };
    transaction.commit?.(trial);
    return {
      committed: true,
      state: trial,
      originalPreserved: false,
      validation,
    };
  } catch (error) {
    const validation: TransactionValidation = {
      acceptable: false,
      reasons: [error instanceof Error ? error.message : 'composition failed'],
    };
    return {
      committed: false,
      state: transaction.currentState,
      originalPreserved: true,
      validation,
    };
  }
}

/** Small adapter for callers that already have a trial builder. */
export function runCompositionTransaction<TState, TPlan>(options: {
  currentState: TState;
  plan: TPlan;
  clone: (state: TState) => TState;
  compose: (trial: TState, plan: TPlan) => void;
  validate: (trial: TState, plan: TPlan) => TransactionValidation;
}): TransactionResult<TState> {
  return applyRepresentationTransaction({
    currentState: options.currentState,
    plan: options.plan,
    cloneCurrentState: options.clone,
    removeOriginalRegion: () => undefined,
    addRepresentation: options.compose,
    validate: options.validate,
  });
}
