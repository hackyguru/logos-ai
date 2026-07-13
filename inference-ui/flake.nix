{
  description = "inference_ui — prompt/response UI for the inference module (QML-only)";

  inputs = {
    logos-module-builder.url = "github:logos-co/logos-module-builder";
    # inference is auto-resolved from metadata.json `dependencies`; attr name must match.
    # Defaults to the sibling source; override at build time if needed:
    #   nix build --override-input inference path:../inference-core '.#lgx-portable'
    inference.url = "path:../inference-core";
    # NOTE: paid providers are settled through the logos_wallet module (which
    # drives logos_execution_zone), but we do NOT build-depend on it — that
    # wallet lives in a separate project and coupling the build to it is fragile.
    # Instead the wallet bar queries logos_wallet at RUNTIME via logos.callModule;
    # if it isn't loaded (Basecamp lazy-loads modules), the bar tells the user to
    # open the Logos Wallet app once, which loads the payment stack.
  };

  outputs = inputs@{ logos-module-builder, ... }:
    logos-module-builder.lib.mkLogosQmlModule {
      src = ./.;
      configFile = ./metadata.json;
      flakeInputs = inputs;
    };
}
