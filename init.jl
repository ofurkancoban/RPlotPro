# v0.38.0 Internal Wipe
print("\r\e[A\e[K")

# Suppress external GR/GKS windows as early as possible
ENV["GKSwstype"] = "100"

# Professional Stealth: Mirror Mode (Total Silence)
# All custom header/logo reconstruction has been removed to preserve native aesthetics.


script_dir = dirname(@__FILE__)
server_path = joinpath(script_dir, "plot_server.jl")

# Re-entry guard: the startup.jl hook and the terminal fallback can both fire for
# the same session, and the fallback retries until Julia reports a port. Loading
# twice redefines the module, starts a second server and stacks a second display,
# so every plot would be captured and sent twice (see #11).
rplotpro_attached = try
    if isdefined(Main, :RPlotPro)
        task = getfield(Main.RPlotPro, :server_task)[]
        task isa Task && !istaskdone(task)
    else
        false
    end
catch
    false
end

if rplotpro_attached
    # Already serving this session - nothing to do.
elseif isfile(server_path)
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
