export const transactionTypes: TransactionTypes[] = [
  'internal-transaction-ok',
  'internal-transaction-error',
  'inbound-transaction-ok',
  'inbound-transaction-error',
  'outbound-transaction-ok',
  'outbound-transaction-error',
];

export type TransactionType = 'internal' | 'inbound' | 'outbound';

export type TransactionTypes =
  | 'internal-transaction-start'
  | 'inbound-transaction-start'
  | 'internal-transaction-ok'
  | 'internal-transaction-error'
  | 'inbound-transaction-ok'
  | 'inbound-transaction-error'
  | 'outbound-transaction-ok'
  | 'outbound-transaction-error';

export interface NostrEvent {
  id: string;
  kind: number;
  pubkey: string;
  created_at: number;
  content: string;
  tags: string[][];
  sig: string;
}

export interface UserBalance {
  pubkey: string;
  balance: number;
  lastUpdated: number;
}

export interface UserTransaction {
  id: string;
  pubkey: string;
  amount: number;
  lastUpdated: number;
  type: string;
  error: boolean;
}
