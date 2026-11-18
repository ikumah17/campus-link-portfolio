import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { ScrollView, Text, TextInput, View } from "react-native";
import { useAuth } from "../src/auth-context";
import {
  conditionParams, conditionsFromParams, genders, loadSchools, normalizeAge, type DiscoverParams, type SearchConditions,
} from "../src/discover-data";
import { LOAD_UNAVAILABLE, searchText as text } from "../src/messages";
import { gateView, useLoad } from "../src/screen";
import { ui } from "../src/theme";
import { Button, Choice, FieldError } from "../src/ui";

const empty: SearchConditions = { genders: [], schoolIds: [] };

// MOBILE-003: the web's /search (src/components/search-conditions.tsx): age, gender and school only. Department and
// class are never conditions (privacy). The conditions go back to discovery as route params.
export default function SearchScreen() {
  const { ready, signedIn, services } = useAuth();
  const router = useRouter();
  const params = useLocalSearchParams<DiscoverParams>();
  const { value } = useLoad((s) => loadSchools(s.supabase), "schools");
  const schools = value?.status === "ok" ? value.schools : null;
  const [conditions, setConditions] = useState<SearchConditions>(empty);
  const [min, setMin] = useState("");
  const [max, setMax] = useState("");
  const [errors, setErrors] = useState<{ min?: string; max?: string }>({});

  useEffect(() => {
    if (!schools) return;
    const current = conditionsFromParams(params, schools);
    setConditions(current); setMin(current.min?.toString() ?? ""); setMax(current.max?.toString() ?? "");
    // The params are read once, when the schools arrive.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schools]);

  const blocked = gateView(ready, signedIn, !!services, value, LOAD_UNAVAILABLE);
  if (blocked || !schools) return blocked;

  function submit() {
    const next: typeof errors = {};
    if (min !== "" && normalizeAge(min) === undefined) next.min = text.ageInvalid;
    if (max !== "" && normalizeAge(max) === undefined) next.max = text.ageInvalid;
    if (!next.min && !next.max && min !== "" && max !== "" && Number(min) > Number(max)) next.min = text.ageOrder;
    setErrors(next);
    if (next.min || next.max) return;
    router.replace({ pathname: "/discover", params: conditionParams({ ...conditions, min: normalizeAge(min), max: normalizeAge(max) }) });
  }
  function clear() { setMin(""); setMax(""); setConditions(empty); setErrors({}); }
  const toggle = <K extends "genders" | "schoolIds">(field: K, id: SearchConditions[K][number]) => setConditions((c) => ({
    ...c, [field]: (c[field] as string[]).includes(id) ? (c[field] as string[]).filter((v) => v !== id) : [...c[field], id],
  }));

  return <ScrollView contentContainerStyle={ui.page} keyboardShouldPersistTaps="handled">
    <Button kind="small" label={text.back} style={{ alignSelf: "flex-start" }}
      onPress={() => router.replace({ pathname: "/discover", params: conditionParams(conditionsFromParams(params, schools)) })} />
    <Text style={[ui.title, { marginTop: 16 }]} accessibilityRole="header">{text.title}</Text>
    <View style={ui.form}>
      <View>
        <Text style={ui.sectionTitle}>{text.age}</Text>
        <View style={[ui.dateRow, { marginTop: 12 }]}>
          <View style={ui.dateInput}>
            <Text style={ui.label}>{text.min}</Text>
            <TextInput testID="search-min" value={min} onChangeText={setMin} keyboardType="number-pad" accessibilityLabel={text.min} style={ui.input} />
          </View>
          <View style={ui.dateInput}>
            <Text style={ui.label}>{text.max}</Text>
            <TextInput testID="search-max" value={max} onChangeText={setMax} keyboardType="number-pad" accessibilityLabel={text.max} style={ui.input} />
          </View>
        </View>
        <FieldError message={errors.min} />
        <FieldError message={errors.max} />
      </View>
      <View>
        <Text style={ui.sectionTitle}>{text.gender}</Text>
        <View style={ui.row}>{genders.map((g) => <Choice key={g.id} role="checkbox" testID={`search-gender-${g.id}`} label={g.label}
          selected={conditions.genders.includes(g.id)} onPress={() => toggle("genders", g.id)} />)}</View>
      </View>
      <View>
        <Text style={ui.sectionTitle}>{text.school}</Text>
        <View style={[ui.row, { flexDirection: "column" }]}>{schools.map((s) => <Choice key={s.id} role="checkbox" testID={`search-school-${s.id}`} label={s.name}
          selected={conditions.schoolIds.includes(s.id)} onPress={() => toggle("schoolIds", s.id)} />)}</View>
      </View>
      <Text style={ui.note}>{text.privacy}</Text>
    </View>
    <View style={ui.actions}>
      <Button testID="search-submit" label={text.submit} onPress={submit} />
      <Button testID="search-clear" kind="secondary" label={text.clear} onPress={clear} />
    </View>
  </ScrollView>;
}
