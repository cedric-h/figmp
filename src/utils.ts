import { CustomError } from "ts-custom-error";
export class BadInput extends CustomError {}

/* handles [de]serializing data that might contain maps */
export const serialize = (x: any) => JSON.stringify(x, (_, v) => {
  if (v.__proto__ == Map.prototype)
    return { "__prototype__": "Map", "data": Object.fromEntries(v.entries()) };
  if (v.__proto__ == Set.prototype)
    return { "__prototype__": "Set", "data": [...v] };
  return v;
});
export const deserialize = (x: string) => JSON.parse(x, (_, v) => {
  if (v.__prototype__ == "Map") return new Map(Object.entries(v.data));
  if (v.__prototype__ == "Set") return new Set(v.data);
  return v;
});
