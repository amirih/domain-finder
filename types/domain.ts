export type DomainStatus = 'pending' | 'checking' | 'available' | 'registered' | 'unknown';

export interface DomainRow {
  id: string;
  name: string;
  domain: string;
  extension: string;
  status: DomainStatus;
  checkedAt?: string;
  lookupUrl?: string;
  rdapUrl?: string;
  detail?: string;
}

export interface CheckResult {
  domain: string;
  status: Exclude<DomainStatus, 'pending' | 'checking'>;
  checkedAt: string;
  lookupUrl?: string;
  rdapUrl?: string;
  detail?: string;
}
