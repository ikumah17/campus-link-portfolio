import { demoAffiliations } from "./demo-affiliations";
import type { Purpose } from "@/lib/onboarding-rules";

export type DemoProfile = {
  id: string;
  name: string;
  age: number;
  gender: string;
  affiliation: string;
  schoolId: string;
  image: string;
  imageAlt: string;
  bio: string;
  purposes: Purpose[];
  hobbies: string[];
};

// Fictional adults only. No real student information.
export const AFFILIATION = "麻生専門学校グループ（デモ所属）";

export const demoProfiles: DemoProfile[] = [
  {
    id: "demo-1",
    schoolId: demoAffiliations[0].id,
    name: "あおい",
    age: 20,
    gender: "女性",
    affiliation: AFFILIATION,
    image: "/demo-profile-1.svg",
    imageAlt: "あおい（架空）のプレースホルダー画像",
    bio: "週末はカフェや映画館に出かけています。気軽に話せる友達が増えたら嬉しいです。",
    purposes: ["friends", "hobby"],
    hobbies: ["カフェ", "映画", "旅行"],
  },
  {
    id: "demo-2",
    schoolId: demoAffiliations[1].id,
    name: "はると",
    age: 21,
    gender: "男性",
    affiliation: AFFILIATION,
    image: "/demo-profile-2.svg",
    imageAlt: "はると（架空）のプレースホルダー画像",
    bio: "写真と音楽が好きです。学校を越えて、趣味の合う友達と出会いたいです。",
    purposes: ["friends", "talk"],
    hobbies: ["写真", "音楽", "散歩"],
  },
  {
    id: "demo-3",
    schoolId: demoAffiliations[1].id,
    name: "ことね",
    age: 19,
    gender: "女性",
    affiliation: AFFILIATION,
    image: "/demo-profile-3.svg",
    imageAlt: "ことね（架空）のプレースホルダー画像",
    bio: "読書とお菓子づくりが趣味です。おすすめの本を紹介し合える友達を探しています。",
    purposes: [],
    hobbies: ["読書", "お菓子づくり", "ヨガ"],
  },
];

export function getDemoProfile(id: string): DemoProfile | undefined {
  return demoProfiles.find((p) => p.id === id);
}
