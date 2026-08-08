export interface MockEligibilityRow {
    /** repo-relative file. */
    file: string;
    /** the function/const that does the resolving. */
    symbol: string;
    kind: 'factory' | 'registry-build' | 'class-resolution' | 'alias-guard' | 'aggregation-filter' | 'scan-stamp' | 'byok-validate' | 'default-strategy' | 'mode-override';
    mockPosture: 'excluded-live' | 'refuses-live' | 'mock-allowed-by-design' | 'test-seam' | 'mode-blind';
    /** existing test that pins this site (referenced, not duplicated). */
    regressionTest?: string;
    notes: string;
}
export declare const MOCK_ELIGIBILITY_INVENTORY: MockEligibilityRow[];
