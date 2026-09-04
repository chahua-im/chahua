import { FeatureGate } from '@/components/FeatureGate';
import {
  IonIcon,
  IonInput,
  IonItem,
  IonLabel,
  IonList,
  IonListHeader,
  IonSelect,
  IonSelectOption,
  IonTextarea,
} from '@ionic/react';
import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { documentText, eye, people, save } from 'ionicons/icons';

interface ChatAdminSettingsProps {
  name: string;
  description: string;
  visibility: 'public' | 'private';
  saving: boolean;
  saveDisabled: boolean;
  onNameChange: (value: string) => void;
  onDescriptionChange: (value: string) => void;
  onVisibilityChange: (value: 'public' | 'private') => void;
  onSave: () => void;
}

export function ChatAdminSettings({
  name,
  description,
  visibility,
  saving,
  saveDisabled,
  onNameChange,
  onDescriptionChange,
  onVisibilityChange,
  onSave,
}: ChatAdminSettingsProps) {
  return (
    <>
      <IonListHeader>
        <IonLabel>
          <Trans>Group</Trans>
        </IonLabel>
      </IonListHeader>
      <IonList inset>
        <IonItem>
          <IonIcon aria-hidden="true" icon={people} slot="start" color="primary" />
          <IonLabel position="stacked">
            <Trans>Group Name</Trans>
          </IonLabel>
          <IonInput
            value={name}
            placeholder={t`Enter group name`}
            onIonInput={(event) => onNameChange(event.detail.value ?? '')}
          />
        </IonItem>
        <IonItem>
          <IonIcon aria-hidden="true" icon={documentText} slot="start" color="tertiary" />
          <IonLabel position="stacked">
            <Trans>Description</Trans>
          </IonLabel>
          <IonTextarea
            value={description}
            placeholder={t`Enter group description`}
            onIonInput={(event) => onDescriptionChange(event.detail.value ?? '')}
            rows={3}
          />
        </IonItem>
        <FeatureGate feature="chatVisibility">
          <IonItem>
            <IonIcon aria-hidden="true" icon={eye} slot="start" color="secondary" />
            <IonLabel>
              <Trans>Visibility</Trans>
            </IonLabel>
            <IonSelect
              value={visibility}
              interface="action-sheet"
              cancelText={t`Cancel`}
              onIonChange={(event) => onVisibilityChange(event.detail.value as 'public' | 'private')}
            >
              <IonSelectOption value="public">
                <Trans>Public</Trans>
              </IonSelectOption>
              <IonSelectOption value="private">
                <Trans>Private</Trans>
              </IonSelectOption>
            </IonSelect>
          </IonItem>
        </FeatureGate>
        <IonItem button detail={false} disabled={saveDisabled} onClick={onSave}>
          <IonIcon aria-hidden="true" icon={save} slot="start" color="primary" />
          <IonLabel color="primary">{saving ? <Trans>Saving...</Trans> : <Trans>Save Settings</Trans>}</IonLabel>
        </IonItem>
      </IonList>
    </>
  );
}
