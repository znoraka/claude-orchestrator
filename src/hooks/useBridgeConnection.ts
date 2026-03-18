import { useState, useEffect } from "react";
import { getConnectionState, onConnectionStateChange, type ConnectionState } from "../lib/bridge";

/** Returns the current bridge connection state, updating reactively. */
export function useBridgeConnection(): ConnectionState {
  const [state, setState] = useState<ConnectionState>(getConnectionState);
  useEffect(() => onConnectionStateChange(setState), []);
  return state;
}
