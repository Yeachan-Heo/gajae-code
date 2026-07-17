import { getBaseUrl } from '../shared/base-url.js';

interface BillingUsage {
  monthlyLimit: number;
  used: number;
  billingPeriodEnd: string;
}

function parseBillingUsage(payload: unknown): BillingUsage {
  if (!payload || typeof payload !== 'object') throw new Error('invalid billing payload');
  const config = (payload as Record<string, unknown>).config;
  if (!config || typeof config !== 'object') throw new Error('invalid billing payload');
  const monthlyLimit = ((config as Record<string, unknown>).monthlyLimit as Record<string, unknown>)
    ?.val;
  const used = ((config as Record<string, unknown>).used as Record<string, unknown>)?.val;
  const billingPeriodEnd = (config as Record<string, unknown>).billingPeriodEnd;
  if (
    typeof monthlyLimit !== 'number' ||
    !Number.isFinite(monthlyLimit) ||
    typeof used !== 'number' ||
    !Number.isFinite(used) ||
    typeof billingPeriodEnd !== 'string' ||
    !Number.isFinite(new Date(billingPeriodEnd).getTime())
  ) {
    throw new Error('invalid billing payload');
  }
  return { monthlyLimit, used, billingPeriodEnd };
}

export async function fetchBillingUsage(token: string): Promise<BillingUsage> {
  const response = await fetch(`${getBaseUrl()}/billing`, {
    headers: {
      authorization: `Bearer ${token}`,
      'x-xai-token-auth': 'xai-grok-cli',
      accept: 'application/json',
    },
  });
  if (!response.ok) throw new Error(`billing endpoint returned ${response.status}`);
  return parseBillingUsage(await response.json());
}

export function formatQuota(usage: BillingUsage | undefined) {
  if (!usage) {
    return [
      '  Usage:',
      '    no billing data available — run /login grok-build or set GROK_CLI_OAUTH_TOKEN',
    ];
  }

  const resetDate = new Date(new Date(usage.billingPeriodEnd).getTime() - 8 * 60 * 60 * 1000);
  return [
    '  Usage:',
    `    ${usage.used.toLocaleString()} / ${usage.monthlyLimit.toLocaleString()} credits used (${Math.round((usage.used / usage.monthlyLimit) * 100)}%)`,
    `    ${(usage.monthlyLimit - usage.used).toLocaleString()} credits remaining`,
    `    Resets at ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][resetDate.getUTCMonth()]} ${resetDate.getUTCDate()} ${resetDate.getUTCHours().toString().padStart(2, '0')}:${resetDate.getUTCMinutes().toString().padStart(2, '0')} PT`,
  ];
}
