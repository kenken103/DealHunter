export const demoRoles = [
  { role: "sales", label: "営業", pickerId: "demo-sales" },
  { role: "student", label: "エンジニア", pickerId: "demo-engineer" },
  { role: "leader", label: "リーダー", pickerId: "demo-leader" },
] as const;

export type DemoAccount = {
  id: string;
  name: string;
  role: (typeof demoRoles)[number]["role"];
  email: string;
  password: string;
};
