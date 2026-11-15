import { handleLexRequest, type LexRequest } from "./markdownTokens";

self.onmessage = ({ data }: MessageEvent<LexRequest>) => {
  handleLexRequest(data, (message) => self.postMessage(message));
};
