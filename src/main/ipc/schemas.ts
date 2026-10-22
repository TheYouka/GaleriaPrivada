// Esquemas zod del IPC [H3-2]. Es el único sitio con esquemas del IPC: el preload y src/shared no
// importan zod. El tipo obliga a declarar un esquema por cada canal de INVOKE_CHANNELS.
import { z } from 'zod';
import type { InvokeChannel, ReqOf } from '@shared/ipc-contract';

export const SCHEMAS: { [C in InvokeChannel]: z.ZodType<ReqOf<C>> } = {
  'app:getInfo': z.undefined(),
};
