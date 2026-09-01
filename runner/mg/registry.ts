/**
 * Compatibility façade for callers that used to import the StoryClaw-owned
 * MG registry. Template names, function schemas and resolvers now live only
 * in the independently versioned template Provider.
 */
import {getMgTemplateProvider} from "@story-claw/mg-templates/provider";
import type {RawMgFunctionCall, ResolvedMgFunctionCall} from "./types.js";

export const mgProvider = getMgTemplateProvider();

export const resolveMgFunctionCall = (call: RawMgFunctionCall): ResolvedMgFunctionCall => {
  const resolved = mgProvider.resolveCall({name: call.name, arguments: call.arguments});
  return {...call, ...resolved};
};

export const elementAts = (call: RawMgFunctionCall): number[] =>
  mgProvider.resolveCall({name: call.name, arguments: call.arguments}).elementAts;
