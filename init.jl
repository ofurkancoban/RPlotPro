# Suppress external GR/GKS windows as early as possible
ENV["GKSwstype"] = "100"

# Hide the 'include' command from terminal by wiping up to 6 lines (Nuclear Stealth).
# No message printed afterward for a completely silent, traceless startup.
print("\e[A\e[2K\e[A\e[2K\e[A\e[2K\e[A\e[2K\e[A\e[2K\e[A\e[2K\r")

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
