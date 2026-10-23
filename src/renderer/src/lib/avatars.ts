// Las 12 ilustraciones de avatar del proyecto (docs/DESIGN.md §14.2), servidas desde app://bundle.
import { BUILTIN_AVATAR_IDS } from '@shared/constants';
import type { BuiltinAvatarId } from '@shared/types';
import aurora from '../assets/avatars/aurora.svg';
import bosque from '../assets/avatars/bosque.svg';
import coral from '../assets/avatars/coral.svg';
import duna from '../assets/avatars/duna.svg';
import eclipse from '../assets/avatars/eclipse.svg';
import fresa from '../assets/avatars/fresa.svg';
import glaciar from '../assets/avatars/glaciar.svg';
import hoja from '../assets/avatars/hoja.svg';
import lava from '../assets/avatars/lava.svg';
import marea from '../assets/avatars/marea.svg';
import nebula from '../assets/avatars/nebula.svg';
import sol from '../assets/avatars/sol.svg';

export const BUILTIN_AVATAR_URLS: Readonly<Record<BuiltinAvatarId, string>> = Object.freeze({
  aurora,
  bosque,
  coral,
  duna,
  eclipse,
  fresa,
  glaciar,
  hoja,
  lava,
  marea,
  nebula,
  sol,
});

export const BUILTIN_AVATAR_LABELS: Readonly<Record<BuiltinAvatarId, string>> = Object.freeze({
  aurora: 'Aurora',
  bosque: 'Bosque',
  coral: 'Coral',
  duna: 'Duna',
  eclipse: 'Eclipse',
  fresa: 'Fresa',
  glaciar: 'Glaciar',
  hoja: 'Hoja',
  lava: 'Lava',
  marea: 'Marea',
  nebula: 'Nebulosa',
  sol: 'Sol',
});

export { BUILTIN_AVATAR_IDS };
