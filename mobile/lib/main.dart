import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'src/gateway.dart';
import 'src/vote.dart';

const gatewayUrl = String.fromEnvironment('GATEWAY_URL',
    defaultValue: 'http://localhost:8088');

void main() {
  runApp(VotacionesApp(gateway: GatewayClient(baseUrl: gatewayUrl)));
}

class VotacionesApp extends StatelessWidget {
  const VotacionesApp({super.key, required this.gateway});

  final GatewayClient gateway;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Votaciones',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xFF0B6E4F)),
        useMaterial3: true,
      ),
      home: InicioPage(gateway: gateway),
    );
  }
}

class InicioPage extends StatefulWidget {
  const InicioPage({super.key, required this.gateway});

  final GatewayClient gateway;

  @override
  State<InicioPage> createState() => _InicioPageState();
}

class _InicioPageState extends State<InicioPage> {
  final _usuario = TextEditingController();
  final _clave = TextEditingController();
  final _codigo = TextEditingController();
  String? _challengeId;
  String? _error;
  bool _ocupado = false;

  @override
  void dispose() {
    _usuario.dispose();
    _clave.dispose();
    _codigo.dispose();
    super.dispose();
  }

  Future<void> _entrar() async {
    setState(() {
      _ocupado = true;
      _error = null;
    });
    try {
      final respuesta = await widget.gateway.post(
          '/api/auth/login',
          {
            'username': _usuario.text.trim(),
            'password': _clave.text,
          },
          anonymous: true);
      if (respuesta is! Map || respuesta['challenge_id'] is! String) {
        throw GatewayException(
            502, 'El servidor no pidió el código de verificación.');
      }
      setState(() => _challengeId = respuesta['challenge_id'] as String);
    } on GatewayException catch (error) {
      setState(() => _error = error.message);
    } finally {
      if (mounted) setState(() => _ocupado = false);
    }
  }

  Future<void> _verificar() async {
    setState(() {
      _ocupado = true;
      _error = null;
    });
    try {
      final respuesta = await widget.gateway.post(
          '/api/auth/login/mfa',
          {
            'challenge_id': _challengeId,
            'code': _codigo.text.trim(),
          },
          anonymous: true);
      if (respuesta is! Map || respuesta['access_token'] is! String) {
        throw GatewayException(502, 'El servidor no entregó la sesión.');
      }
      widget.gateway.accessToken = respuesta['access_token'] as String;
      if (!mounted) return;
      await Navigator.of(context).push(MaterialPageRoute<void>(
        builder: (_) => EleccionesPage(gateway: widget.gateway),
      ));
      widget.gateway.accessToken = null;
    } on GatewayException catch (error) {
      setState(() => _error = error.message);
    } finally {
      if (mounted) setState(() => _ocupado = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final mfa = _challengeId != null;
    return Scaffold(
      body: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 420),
          child: ListView(
            padding: const EdgeInsets.all(24),
            children: [
              const SizedBox(height: 48),
              Text('Votaciones',
                  style: Theme.of(context).textTheme.headlineMedium),
              const SizedBox(height: 8),
              Text(
                mfa
                    ? 'Escribe el código de verificación.'
                    : 'Entra con tu usuario para ver las elecciones abiertas.',
                style: Theme.of(context).textTheme.bodyLarge,
              ),
              const SizedBox(height: 24),
              if (!mfa) ...[
                TextField(
                    controller: _usuario,
                    decoration: const InputDecoration(labelText: 'Usuario'),
                    textInputAction: TextInputAction.next),
                const SizedBox(height: 12),
                TextField(
                    controller: _clave,
                    decoration: const InputDecoration(labelText: 'Contraseña'),
                    obscureText: true),
              ] else
                TextField(
                  controller: _codigo,
                  decoration: const InputDecoration(labelText: 'Código'),
                  keyboardType: TextInputType.number,
                  maxLength: 6,
                ),
              if (_error != null) ...[
                const SizedBox(height: 12),
                Text(_error!,
                    style:
                        TextStyle(color: Theme.of(context).colorScheme.error)),
              ],
              const SizedBox(height: 20),
              FilledButton(
                onPressed: _ocupado ? null : (mfa ? _verificar : _entrar),
                child: Text(
                    _ocupado ? 'Espera…' : (mfa ? 'Verificar' : 'Continuar')),
              ),
              const SizedBox(height: 16),
              Text(
                'Prueba local: votante1, contraseña prueba123, código 123456.',
                style: Theme.of(context).textTheme.bodySmall,
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class EleccionesPage extends StatefulWidget {
  const EleccionesPage({super.key, required this.gateway});

  final GatewayClient gateway;

  @override
  State<EleccionesPage> createState() => _EleccionesPageState();
}

class _EleccionesPageState extends State<EleccionesPage> {
  late Future<List<EleccionAbierta>> _elecciones;

  @override
  void initState() {
    super.initState();
    _elecciones = eleccionesAbiertas(widget.gateway);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Elecciones abiertas')),
      body: FutureBuilder<List<EleccionAbierta>>(
        future: _elecciones,
        builder: (context, snapshot) {
          if (snapshot.connectionState != ConnectionState.done) {
            return const Center(child: CircularProgressIndicator());
          }
          if (snapshot.hasError) {
            final error = snapshot.error;
            return Center(
                child: Text(error is GatewayException
                    ? error.message
                    : 'No se pudieron cargar las elecciones.'));
          }
          final elecciones = snapshot.data ?? const [];
          if (elecciones.isEmpty) {
            return const Center(child: Text('No hay elecciones abiertas.'));
          }
          return ListView.separated(
            itemCount: elecciones.length,
            separatorBuilder: (_, __) => const Divider(height: 1),
            itemBuilder: (context, index) {
              final eleccion = elecciones[index];
              return ListTile(
                title: Text(eleccion.name),
                subtitle: Text('Elección ${eleccion.id}'),
                trailing: const Icon(Icons.chevron_right),
                onTap: () {
                  Navigator.of(context).push(MaterialPageRoute<void>(
                    builder: (_) => VotoPage(
                        gateway: widget.gateway,
                        electionId: eleccion.id,
                        name: eleccion.name),
                  ));
                },
              );
            },
          );
        },
      ),
    );
  }
}

class VotoPage extends StatefulWidget {
  const VotoPage(
      {super.key,
      required this.gateway,
      required this.electionId,
      required this.name});

  final GatewayClient gateway;
  final String electionId;
  final String name;

  @override
  State<VotoPage> createState() => _VotoPageState();
}

class _VotoPageState extends State<VotoPage> {
  late Future<ParametrosUrna> _parametros;
  String? _opcion;
  String? _error;
  bool _ocupado = false;
  ReciboVoto? _recibo;

  @override
  void initState() {
    super.initState();
    _parametros = parametrosUrna(widget.gateway, widget.electionId);
  }

  Future<void> _votar(ParametrosUrna parametros) async {
    final opcion = _opcion;
    if (opcion == null) {
      setState(() => _error = 'Selecciona una opción.');
      return;
    }
    setState(() {
      _ocupado = true;
      _error = null;
    });
    try {
      final recibo = await emitirPapeleta(widget.gateway, parametros, opcion);
      setState(() => _recibo = recibo);
    } on GatewayException catch (error) {
      setState(() => _error = error.message);
    } catch (error) {
      setState(() => _error = '$error');
    } finally {
      if (mounted) setState(() => _ocupado = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_recibo != null) {
      return Scaffold(
        appBar: AppBar(title: const Text('Recibo')),
        body: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(_recibo!.reintento
                  ? 'Esta papeleta ya estaba registrada. Este es el mismo recibo.'
                  : 'Tu papeleta quedó registrada.'),
              const SizedBox(height: 16),
              SelectableText(_recibo!.recibo),
              const SizedBox(height: 16),
              OutlinedButton(
                onPressed: () {
                  Clipboard.setData(ClipboardData(text: _recibo!.recibo));
                },
                child: const Text('Copiar recibo'),
              ),
            ],
          ),
        ),
      );
    }
    return Scaffold(
      appBar: AppBar(title: Text(widget.name)),
      body: FutureBuilder<ParametrosUrna>(
        future: _parametros,
        builder: (context, snapshot) {
          if (snapshot.connectionState != ConnectionState.done) {
            return const Center(child: CircularProgressIndicator());
          }
          if (snapshot.hasError || snapshot.data == null) {
            final error = snapshot.error;
            return Center(
                child: Text(error is GatewayException
                    ? error.message
                    : 'No se pudieron cargar las opciones.'));
          }
          final parametros = snapshot.data!;
          return RadioGroup<String>(
            groupValue: _opcion,
            onChanged: (value) {
              if (_ocupado) return;
              setState(() => _opcion = value);
            },
            child: ListView(
              padding: const EdgeInsets.all(24),
              children: [
                const Text('Elige una opción. La papeleta sale sin tu sesión.'),
                const SizedBox(height: 12),
                for (final opcion in parametros.options)
                  RadioListTile<String>(
                    value: opcion,
                    title: Text(opcion),
                    enabled: !_ocupado,
                  ),
                if (_error != null)
                  Text(_error!,
                      style: TextStyle(
                          color: Theme.of(context).colorScheme.error)),
                const SizedBox(height: 12),
                FilledButton(
                  onPressed: _ocupado ? null : () => _votar(parametros),
                  child: Text(_ocupado ? 'Enviando…' : 'Enviar papeleta'),
                ),
              ],
            ),
          );
        },
      ),
    );
  }
}
