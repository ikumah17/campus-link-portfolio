import { Text, TextInput, View } from "react-native";
import { onboardingText as text } from "./messages";
import { codePointLength, PURPOSE_LABELS, PURPOSES, type Purpose } from "./shared";
import { ui } from "./theme";
import { Choice, FieldError } from "./ui";

// MOBILE-LIKES-001: the web's PurposeFields and BioField (src/components/onboarding.tsx, docs/43 §4.4), shared by
// onboarding and the profile edit screen. The chosen purposes stay in the fixed order, as the database stores them.
export function PurposeFields({ purposes, onChange, error, disabled = false }: { purposes: Purpose[]; onChange: (next: Purpose[]) => void; error?: string; disabled?: boolean }) {
  return <View accessibilityLabel={text.purposes}>
    <Text style={ui.label}>{text.purposes}</Text>
    <Text style={ui.hint}>{text.purposesNote}</Text>
    <View style={[ui.row, { flexDirection: "column" }]}>{PURPOSES.map((p) => <Choice key={p} testID={`purpose-${p}`} role="checkbox" label={PURPOSE_LABELS[p]}
      selected={purposes.includes(p)} disabled={disabled}
      onPress={() => onChange(purposes.includes(p) ? purposes.filter((v) => v !== p) : PURPOSES.filter((v) => v === p || purposes.includes(v)))} />)}</View>
    <FieldError message={error} />
  </View>;
}

export function BioField({ bio, onChange, error, disabled = false }: { bio: string; onChange: (next: string) => void; error?: string; disabled?: boolean }) {
  return <View>
    <Text style={ui.label}>{text.bio}</Text>
    <TextInput testID="bio" style={[ui.input, { minHeight: 112, textAlignVertical: "top" }]} multiline value={bio} onChangeText={onChange}
      accessibilityLabel={text.bio} editable={!disabled} />
    <Text style={[ui.hint, { textAlign: "right" }]} accessibilityLiveRegion="polite">{codePointLength(bio)}{text.bioCount}</Text>
    <FieldError message={error} />
  </View>;
}
