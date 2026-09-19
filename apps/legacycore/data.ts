/**
 * Seed data and tenant configuration for the LegacyCore Teller Console mock.
 * Everything here is fake. Member numbers are shared across tenants to mimic two
 * institutions running the same vendor product with different data/branding.
 */

export type TenantId = "summit" | "cascade";
export type AccountColumn = "shareId" | "type" | "description" | "balance" | "available";

export interface TenantConfig {
  id: TenantId;
  institution: string;
  bannerColor: string;
  inquiryNavText: string;
  loginUserField: string;
  loginPassField: string;
  loginButton: string;
  inquiryLabel: string;
  inquiryField: string;
  inquiryButton: string;
  accountColumns: AccountColumn[];
  confirmButton: string;
  noticeAfterLogin: boolean;
  passwordEnv: string;
  passwordDefault: string;
}

export const TENANTS: Record<TenantId, TenantConfig> = {
  summit: {
    id: "summit",
    institution: "Summit Federal Credit Union",
    bannerColor: "#1f3a5f",
    inquiryNavText: "Member Inquiry",
    loginUserField: "userid",
    loginPassField: "passwd",
    loginButton: "Sign On",
    inquiryLabel: "Member Number",
    inquiryField: "memberno",
    inquiryButton: "Search",
    accountColumns: ["shareId", "type", "description", "balance", "available"],
    confirmButton: "Confirm",
    noticeAfterLogin: false,
    passwordEnv: "LEGACYCORE_PASSWORD",
    passwordDefault: "Summit#2024!",
  },
  cascade: {
    id: "cascade",
    institution: "Cascade Community Credit Union",
    bannerColor: "#2f5d3a",
    inquiryNavText: "Member Lookup",
    loginUserField: "uid",
    loginPassField: "pwd",
    loginButton: "Logon",
    inquiryLabel: "Member #",
    inquiryField: "mbr_num",
    inquiryButton: "Find",
    accountColumns: ["type", "shareId", "description", "available", "balance"],
    confirmButton: "Post",
    noticeAfterLogin: true,
    passwordEnv: "LEGACYCORE_CASCADE_PASSWORD",
    passwordDefault: "Cascade#2024!",
  },
};

export const ACCOUNT_COLUMN_LABELS: Record<AccountColumn, string> = {
  shareId: "Share ID",
  type: "Type",
  description: "Description",
  balance: "Balance",
  available: "Available",
};

export function isTenantId(id: string | undefined): id is TenantId {
  return id === "summit" || id === "cascade";
}

export function tenantPassword(t: TenantConfig): string {
  return process.env[t.passwordEnv] ?? t.passwordDefault;
}

export function tellerUser(): string {
  return process.env.LEGACYCORE_USER ?? "teller1";
}

export interface Share {
  id: string;
  type: string;
  description: string;
  balance: number;
  available: number;
}

export interface Member {
  number: string;
  name: string;
  lastName: string;
  address: string;
  phone: string;
  ssnMasked: string;
  memberSince: string;
  restricted: boolean;
  shares: Share[];
}

function share(
  id: string,
  type: string,
  description: string,
  balance: number,
  available = balance,
): Share {
  return { id, type, description, balance, available };
}

function seedSummit(): Member[] {
  return [
    {
      number: "10023",
      name: "Alice Johnson",
      lastName: "Johnson",
      address: "1420 Maple Ave, Boulder, CO 80301",
      phone: "(303) 555-0142",
      ssnMasked: "***-**-4821",
      memberSince: "03/14/2009",
      restricted: false,
      shares: [
        share("0001", "Savings", "Regular Share", 4250.37, 4200.37),
        share("0010", "Checking", "Share Draft", 1120.0),
      ],
    },
    {
      number: "10024",
      name: "Bob Martinez",
      lastName: "Martinez",
      address: "88 Ridge Rd, Golden, CO 80401",
      phone: "(720) 555-0177",
      ssnMasked: "***-**-1937",
      memberSince: "11/02/2015",
      restricted: false,
      shares: [
        share("0001", "Savings", "Regular Share", 312.19),
        share("0010", "Checking", "Share Draft", 2045.88),
        share("0020", "Certificate", "12 Month Certificate", 10000.0, 0),
      ],
    },
    {
      number: "10087",
      name: "Carol Nguyen",
      lastName: "Nguyen",
      address: "501 Pine St Apt 3B, Denver, CO 80202",
      phone: "(303) 555-0119",
      ssnMasked: "***-**-7304",
      memberSince: "06/21/2003",
      restricted: false,
      shares: [share("0001", "Savings", "Regular Share", 18904.55)],
    },
    {
      number: "10101",
      name: "Dev Patel",
      lastName: "Patel",
      address: "2 Aspen Ct, Longmont, CO 80501",
      phone: "(970) 555-0163",
      ssnMasked: "***-**-2280",
      memberSince: "01/09/2024",
      restricted: false,
      shares: [share("0001", "Savings", "Regular Share", 0.0)],
    },
    {
      number: "55555",
      name: "Restricted Member",
      lastName: "Member",
      address: "(withheld)",
      phone: "(withheld)",
      ssnMasked: "***-**-****",
      memberSince: "07/30/2011",
      restricted: true,
      shares: [share("0001", "Savings", "Regular Share", 0.0)],
    },
  ];
}

function seedCascade(): Member[] {
  return [
    {
      number: "10023",
      name: "Alicia Johnston",
      lastName: "Johnston",
      address: "77 River Bend Dr, Bend, OR 97701",
      phone: "(541) 555-0128",
      ssnMasked: "***-**-6610",
      memberSince: "09/12/2012",
      restricted: false,
      shares: [
        share("0001", "Savings", "Prime Share", 2780.1),
        share("0010", "Checking", "Share Draft", 640.25),
      ],
    },
    {
      number: "10024",
      name: "Roberto Martinez",
      lastName: "Martinez",
      address: "1301 Cascade Ave, Hood River, OR 97031",
      phone: "(541) 555-0190",
      ssnMasked: "***-**-3352",
      memberSince: "02/27/2018",
      restricted: false,
      shares: [
        share("0001", "Savings", "Prime Share", 1503.4),
        share("0010", "Checking", "Share Draft", 89.9),
      ],
    },
    {
      number: "10087",
      name: "Carolyn Ng",
      lastName: "Ng",
      address: "9 Lakeshore Ln, Eugene, OR 97401",
      phone: "(458) 555-0107",
      ssnMasked: "***-**-9045",
      memberSince: "05/05/2005",
      restricted: false,
      shares: [
        share("0001", "Savings", "Prime Share", 22410.0),
        share("0020", "Certificate", "24 Month Certificate", 5000.0, 0),
      ],
    },
    {
      number: "10101",
      name: "Devi Patil",
      lastName: "Patil",
      address: "410 Summit View, Salem, OR 97301",
      phone: "(503) 555-0155",
      ssnMasked: "***-**-1178",
      memberSince: "12/18/2023",
      restricted: false,
      shares: [share("0001", "Savings", "Prime Share", 25.0)],
    },
    {
      number: "55555",
      name: "Restricted Member",
      lastName: "Member",
      address: "(withheld)",
      phone: "(withheld)",
      ssnMasked: "***-**-****",
      memberSince: "04/01/2010",
      restricted: true,
      shares: [share("0001", "Savings", "Prime Share", 0.0)],
    },
  ];
}

/** In-memory data store; `reset()` restores the seed (used by `POST /__reset`). */
export class DataStore {
  private members = new Map<TenantId, Map<string, Member>>();

  constructor() {
    this.reset();
  }

  reset(): void {
    this.members = new Map([
      ["summit", new Map(seedSummit().map((m) => [m.number, m]))],
      ["cascade", new Map(seedCascade().map((m) => [m.number, m]))],
    ]);
  }

  getMember(tenant: TenantId, number: string): Member | undefined {
    return this.members.get(tenant)?.get(number);
  }

  findByLastName(tenant: TenantId, prefix: string): Member[] {
    const p = prefix.trim().toLowerCase();
    if (!p) return [];
    return [...(this.members.get(tenant)?.values() ?? [])].filter((m) =>
      m.lastName.toLowerCase().startsWith(p),
    );
  }

  /** New share ids start at 0030 and increment per member. */
  nextShareId(member: Member): string {
    let n = 30;
    const taken = new Set(member.shares.map((s) => s.id));
    while (taken.has(String(n).padStart(4, "0"))) n += 1;
    return String(n).padStart(4, "0");
  }

  addShare(
    member: Member,
    type: string,
    description: string,
    deposit: number,
    fundFromId: string,
  ): Share {
    const funding = member.shares.find((s) => s.id === fundFromId);
    if (funding) {
      funding.balance = round2(funding.balance - deposit);
      funding.available = round2(funding.available - deposit);
    }
    const created = share(this.nextShareId(member), type, description, round2(deposit));
    member.shares.push(created);
    return created;
  }
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function money(n: number): string {
  return "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
