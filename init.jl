# v0.38.0 Internal Wipe
print("\r\e[A\e[K")

# Suppress external GR/GKS windows as early as possible
ENV["GKSwstype"] = "100"

# Professional Stealth: Mirror Mode (Total Silence)
# All custom header/logo reconstruction has been removed to preserve native aesthetics.


script_dir = dirname(@__FILE__)
server_path = joinpath(script_dir, "plot_server.jl")

if isfile(server_path)
    try
        include(server_path)
        # The server script should define RPlotPro module
        if isdefined(Main, :RPlotPro)
            if isdefined(Main.RPlotPro, :start_plot_viewer)
                Main.RPlotPro.start_plot_viewer()
            end
        end
    catch e
        @warn "R Plot Pro: Error during initialization" exception=(e, catch_backtrace())
    end
else
    @warn "R Plot Pro: Could not find plot_server.jl at $server_path"
end

nothing
