// Fictional master data, matching supabase/seed.sql (not the privacy demo targets).
export const demoAffiliations = ["A", "B"].map((letter, schoolIndex) => {
  const s = schoolIndex + 1;
  return {
    id: `00000000-0000-4000-8000-00000000a00${s}`,
    name: `デモ学校${letter}（架空）`,
    departments: [1, 2].map((d) => ({
      id: `00000000-0000-4000-8000-00000000b0${s}${d}`,
      name: `デモ学科${letter}${d}（架空）`,
      classes: [1, 2].map((c) => ({
        id: `00000000-0000-4000-8000-00000000c${s}${d}${c}`,
        name: `デモクラス${letter}${d}-${c}（架空）`,
      })),
    })),
  };
});

export const demoPhotos = [1, 2, 3].map((n) => ({
  id: `demo-profile-${n}`,
  src: `/demo-profile-${n}.svg`,
  alt: `架空のプロフィール写真${n}`,
}));
