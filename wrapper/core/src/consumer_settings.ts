/** The startup line each wrapper prints once the objects that act on operator
 *  settings (host, watchdog, broker) are constructed, from values those
 *  objects hold. A value cut anywhere between the resolved configuration and
 *  a consumer therefore shows here; a line printed before construction could
 *  not show it. The pid lets an integration test confirm termination of
 *  exactly the process it observed. `null` means the consumer applies no
 *  limit. */
export function formatConsumerSettingsLine(
  engine: string,
  pid: number,
  settings: ReadonlyArray<readonly [name: string, value: number | string | null]>,
): string {
  return (
    `[kaoiro] ${engine} consumers: pid=${pid} ` +
    `${settings.map(([name, value]) => `${name}=${value ?? "none"}`).join(" ")}\n`
  );
}
