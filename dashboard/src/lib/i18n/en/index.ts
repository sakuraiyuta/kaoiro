import { agentCard } from "./agentCard";
import { agentDetail } from "./agentDetail";
import { agentGridShell } from "./agentGridShell";
import { app } from "./app";
import { bottomSheet } from "./bottomSheet";
import { common } from "./common";
import { deliveryPolicy } from "./deliveryPolicy";
import { deviceApproval } from "./deviceApproval";
import { language } from "./language";
import { launchDialog } from "./launchDialog";
import { personaDetailDialog } from "./personaDetailDialog";
import { protocol } from "./protocol";
import { responseTimeline } from "./responseTimeline";
import { sessionLifecycleDialog } from "./sessionLifecycleDialog";
import { settingsDrawer } from "./settingsDrawer";
import { statusLine } from "./statusLine";
import { statusLineHistoryDialog } from "./statusLineHistoryDialog";
import { statusLinePanel } from "./statusLinePanel";
import { taskRing } from "./taskRing";
import { tasklistFloat } from "./tasklistFloat";
import { time } from "./time";
import { untrustedMarkdown } from "./untrustedMarkdown";
import { workCapacitySettings } from "./workCapacitySettings";
import { ja, type Messages } from "../ja";

const table = {
  agentCard,
  agentDetail,
  agentGridShell,
  app,
  bottomSheet,
  common,
  deliveryPolicy,
  deviceApproval,
  language,
  launchDialog,
  personaDetailDialog,
  protocol,
  responseTimeline,
  sessionLifecycleDialog,
  settingsDrawer,
  statusLine,
  statusLineHistoryDialog,
  statusLinePanel,
  taskRing,
  tasklistFloat,
  time,
  untrustedMarkdown,
  workCapacitySettings,
};

// Missing keys, extra areas and argument mismatches fail here.
export const en: Messages = table;
// An area file that forgot its `Messages[...]` annotation and gained an extra
// key fails here.
ja satisfies typeof table;
