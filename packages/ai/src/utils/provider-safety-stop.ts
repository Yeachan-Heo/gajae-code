/**
 * Public provider safety-stop surface (issue #4777 review follow-up).
 *
 * First-party adapters mint terminal authority through the package-private
 * adapter-internals module. Public consumers may only verify existing
 * authority; message fields and structured refusal text never mint authority.
 */
export { isProviderSafetyStopAuthenticated } from "../adapter-internals/provider-safety-stop";
