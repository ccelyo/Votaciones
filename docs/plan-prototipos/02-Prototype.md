# Distribución del trabajo --- Prototipo 2 de Votaciones

## 1. Objetivo

Este documento define la distribución del trabajo entre los ocho
integrantes del equipo para implementar el prototipo 2 del sistema de
votaciones, con base en la vista de componentes y conectores acordada.

La propuesta contempla los componentes de presentación, los servicios
lógicos, las bases de datos, la comunicación asíncrona mediante RabbitMQ
y el despliegue. Cada integrante tendrá responsabilidades concretas y
entregables verificables.

## 2. Asignación de responsabilidades por integrante

  -----------------------------------------------------------------------
  Integrante        Componentes       Tecnologías       Responsabilidad
                    asignados                           principal
  ----------------- ----------------- ----------------- -----------------
  **Cristhian**     API Gateway y Web TypeScript,       Implementar el
                    SSR               Next.js           punto de entrada
                                                        al backend y la
                                                        interfaz web con
                                                        renderizado del
                                                        lado del
                                                        servidor.

  **Julian**        Auth, base de     Python,           Implementar la
                    datos Auth y CLI  PostgreSQL, Java  autenticación de
                    Admin                               usuarios, su
                                                        persistencia y la
                                                        interfaz de
                                                        administración
                                                        por consola.

  **Fabian**        Election y base   Python,           Implementar la
                    de datos          PostgreSQL        gestión de
                    Elections                           elecciones y su
                                                        persistencia.

  **Kevin**         Identity, base de Python,           Gestionar la
                    datos Census y    PostgreSQL        identidad de los
                    Blind Signature                     votantes,
                                                        consultar el
                                                        censo electoral e
                                                        implementar el
                                                        servicio de firma
                                                        ciega.

  **Andres**        Ballot, base de   Go, MongoDB,      Implementar la
                    datos Votes y App Flutter/Dart      recepción de
                    móvil                               papeletas y la
                                                        aplicación móvil
                                                        para interactuar
                                                        con el sistema.

  **Sebastian**     Tally y Pub/Sub   Go, RabbitMQ      Implementar el
                    RabbitMQ                            procesamiento de
                                                        eventos y la
                                                        coordinación de
                                                        la comunicación
                                                        asíncrona para
                                                        los votos.

  **Camilo**        Notifications y   TypeScript,       Implementar el
                    base de datos     MongoDB           servicio de
                    Notif. DB                           notificaciones,
                                                        el consumo de
                                                        eventos y la
                                                        persistencia de
                                                        sus registros.

  **Sergio**        Analytics y base  Rust, MongoDB     Implementar el
                    de datos Results                    procesamiento
                                                        analítico de los
                                                        votos y el
                                                        almacenamiento de
                                                        resultados.
  -----------------------------------------------------------------------

Esta distribución es una propuesta de trabajo. Las responsabilidades
adicionales de integración, despliegue y documentación se especifican en
las secciones siguientes. El componente RabbitMQ se asigna a Sebastian
como responsable de la infraestructura de mensajería, pero cada
productor y consumidor debe implementar su propia integración.

## 3. Actividades específicas por integrante

### 3.1. Cristhian --- API Gateway y Web SSR

**Objetivo:** permitir que los clientes accedan al sistema a través de
un punto de entrada común y proporcionar la interfaz web.

  -----------------------------------------------------------------------
  ID                      Actividad               Entregable
  ----------------------- ----------------------- -----------------------
  CR-01                   Definir las rutas HTTP  Catálogo de endpoints.
                          para Auth, Election,    
                          Identity, Blind         
                          Signature, Ballot,      
                          Tally, Analytics y      
                          Notifications.          

  CR-02                   Implementar el API      Servicio ejecutable del
                          Gateway en TypeScript.  Gateway.

  CR-03                   Configurar el           Configuración de rutas.
                          enrutamiento hacia los  
                          servicios mediante      
                          REST/JSON.              

  CR-04                   Implementar la          Middleware de
                          validación de JWT en el validación de tokens.
                          Gateway, según los      
                          requisitos de           
                          autenticación           
                          acordados.              

  CR-05                   Implementar el frontend Aplicación web
                          web en Next.js          funcional.
                          utilizando SSR.         

  CR-06                   Desarrollar las         Flujos de usuario en la
                          pantallas necesarias    web.
                          para autenticación,     
                          consulta de elecciones, 
                          votación y consulta de  
                          resultados, de acuerdo  
                          con el alcance          
                          funcional definido.     

  CR-07                   Integrar el frontend    Web conectada al
                          con el Gateway y        backend.
                          gestionar los errores   
                          de comunicación.        

  CR-08                   Crear Dockerfiles para  Contenedores del
                          los componentes         Gateway y de la web.
                          asignados y probar su   
                          ejecución.              
  -----------------------------------------------------------------------

**Criterio de aceptación:** el frontend web utiliza SSR y puede
comunicarse con los servicios a través del Gateway, sin conectarse
directamente a sus bases de datos.

### 3.2. Julian --- Auth, PostgreSQL y CLI Admin

**Objetivo:** gestionar la autenticación y ofrecer una interfaz
administrativa por consola.

  -----------------------------------------------------------------------
  ID                      Actividad               Entregable
  ----------------------- ----------------------- -----------------------
  JU-01                   Revisar y adaptar la    Inventario de
                          autenticación existente funcionalidades
                          en el prototipo 1.      reutilizables.

  JU-02                   Implementar el servicio API de autenticación.
                          Auth en Python.         

  JU-03                   Diseñar y configurar la Esquema y configuración
                          base de datos Auth en   de persistencia.
                          PostgreSQL.             

  JU-04                   Implementar las         Operaciones de gestión
                          operaciones de registro de usuarios.
                          o gestión de usuarios   
                          que correspondan al     
                          alcance acordado.       

  JU-05                   Implementar la          Emisión de tokens
                          generación de JWT y     compatible con el
                          definir sus atributos y Gateway.
                          tiempos de expiración,  
                          coordinándose con       
                          Cristhian.              

  JU-06                   Desarrollar la CLI      Cliente de consola
                          administrativa en Java. ejecutable.

  JU-07                   Implementar las         Comandos de
                          operaciones             administración.
                          administrativas         
                          acordadas mediante las  
                          interfaces HTTP.        

  JU-08                   Crear pruebas de        Pruebas y
                          autenticación,          documentación.
                          persistencia y          
                          ejecución de la CLI.    
  -----------------------------------------------------------------------

**Criterio de aceptación:** el usuario puede autenticarse, obtener un
token válido y utilizar la CLI para ejecutar las operaciones
administrativas autorizadas.

**Dependencia importante:** Julian y Cristhian deben acordar desde el
principio el formato del JWT, el secreto o mecanismo de firma y las
reglas de validación.

### 3.3. Fabian --- Election y PostgreSQL

**Objetivo:** administrar las elecciones y proporcionar los datos
necesarios para que los clientes consulten las opciones disponibles.

  -----------------------------------------------------------------------
  ID                      Actividad               Entregable
  ----------------------- ----------------------- -----------------------
  FA-01                   Definir el modelo de    Modelo
                          datos de las            entidad-relación.
                          elecciones.             

  FA-02                   Diseñar y configurar la Esquema de base de
                          base de datos Elections datos.
                          en PostgreSQL.          

  FA-03                   Implementar el servicio Servicio de gestión de
                          Election en Python.     elecciones.

  FA-04                   Implementar las         Endpoints HTTP.
                          operaciones para crear, 
                          consultar, actualizar y 
                          cerrar elecciones,      
                          según los permisos      
                          establecidos.           

  FA-05                   Definir los estados de  Reglas de negocio
                          una elección y las      documentadas.
                          validaciones            
                          correspondientes.       

  FA-06                   Implementar la          Productor de
                          publicación de eventos  `election.events`.
                          de elección en          
                          RabbitMQ, en            
                          coordinación con        
                          Sebastian.              

  FA-07                   Probar las operaciones  Pruebas automatizadas.
                          del servicio y la       
                          persistencia.           

  FA-08                   Preparar el contenedor  Dockerfile y
                          y la configuración de   configuración del
                          conexión a PostgreSQL.  servicio.
  -----------------------------------------------------------------------

**Criterio de aceptación:** las elecciones pueden administrarse y
consultarse mediante HTTP, y los eventos acordados se publican
correctamente.

### 3.4. Kevin --- Identity, Census y Blind Signature

**Objetivo:** gestionar la identidad electoral y separar la verificación
de los votantes de la emisión de firmas ciegas.

  -----------------------------------------------------------------------
  ID                      Actividad               Entregable
  ----------------------- ----------------------- -----------------------
  KE-01                   Analizar la lógica de   Inventario de código
                          identidad y firma ciega reutilizable.
                          del prototipo 1.        

  KE-02                   Diseñar la estructura   Esquema de Census.
                          del censo electoral en  
                          PostgreSQL.             

  KE-03                   Implementar el servicio API de identidad.
                          Identity en Python.     

  KE-04                   Implementar las         Endpoints y reglas de
                          operaciones de consulta elegibilidad.
                          y validación de la      
                          elegibilidad electoral. 

  KE-05                   Separar la              Servicio independiente
                          implementación          de firma ciega.
                          criptográfica en el     
                          servicio Blind          
                          Signature.              

  KE-06                   Definir el contrato de  Interfaz documentada.
                          comunicación entre      
                          Identity y Blind        
                          Signature.              

  KE-07                   Implementar las         Pruebas del protocolo.
                          validaciones            
                          criptográficas y las    
                          pruebas                 
                          correspondientes.       

  KE-08                   Coordinar con Sebastian Integración con
                          la publicación de los   `identity.events`.
                          eventos de identidad    
                          que sean necesarios.    

  KE-09                   Crear los contenedores  Servicios ejecutables.
                          y probar las conexiones 
                          con PostgreSQL.         
  -----------------------------------------------------------------------

**Criterio de aceptación:** el sistema puede validar la elegibilidad
electoral y ejecutar el flujo de firma ciega sin introducir una
asociación indebida entre la identidad del votante y su voto.

**Precaución:** Identity y Blind Signature son dos componentes
independientes en la vista C&C. Deben mantenerse separados en el
despliegue y en sus contratos, aunque compartan lenguaje y responsable.

### 3.5. Andres --- Ballot, Votes y App móvil

**Objetivo:** implementar la recepción de votos y la aplicación móvil
que permita a los usuarios interactuar con el sistema.

  -----------------------------------------------------------------------
  ID                      Actividad               Entregable
  ----------------------- ----------------------- -----------------------
  AN-01                   Definir el modelo de    Esquema de la papeleta.
                          una papeleta            
                          electrónica.            

  AN-02                   Implementar el servicio API de recepción de
                          Ballot en Go.           votos.

  AN-03                   Configurar la           Colección Votes.
                          persistencia de votos   
                          en MongoDB.             

  AN-04                   Implementar la          Flujo de recepción
                          recepción y validación  funcional.
                          de papeletas.           

  AN-05                   Definir las reglas de   Validaciones y pruebas.
                          aceptación y prevención 
                          de duplicados.          

  AN-06                   Implementar la          Productor de
                          publicación de eventos  `votes.events`.
                          de voto en RabbitMQ.    

  AN-07                   Desarrollar la          Aplicación móvil
                          aplicación móvil en     funcional.
                          Flutter/Dart.           

  AN-08                   Integrar la aplicación  Cliente móvil conectado
                          móvil con el API        al backend.
                          Gateway.                

  AN-09                   Crear los contenedores  Configuración de
                          necesarios para los     ejecución.
                          componentes que lo      
                          requieran y documentar  
                          cómo ejecutar la        
                          aplicación móvil.       
  -----------------------------------------------------------------------

**Criterio de aceptación:** un usuario puede utilizar la aplicación
móvil para interactuar con el sistema y enviar una papeleta válida, que
se procesa y persiste correctamente.

**Importante:** la aplicación móvil no debe conectarse directamente a
MongoDB. Todas las operaciones deben pasar por las interfaces HTTP
definidas.

### 3.6. Sebastian --- Tally y RabbitMQ

**Objetivo:** implementar el procesamiento de los votos y proporcionar
la infraestructura de comunicación asíncrona.

  -----------------------------------------------------------------------
  ID                      Actividad               Entregable
  ----------------------- ----------------------- -----------------------
  SE-01                   Configurar RabbitMQ     Broker operativo.
                          para ejecutarse dentro  
                          de la red Docker.       

  SE-02                   Definir las colas,      Configuración de
                          exchanges, routing keys mensajería.
                          y reglas de             
                          enrutamiento            
                          necesarias.             

  SE-03                   Documentar los          Esquemas de eventos.
                          contratos de            
                          `identity.events`,      
                          `election.events` y     
                          `votes.events`.         

  SE-04                   Implementar el servicio Servicio de conteo de
                          Tally en Go.            votos.

  SE-05                   Definir cómo recibe     Contrato de entrada de
                          Tally los eventos o las Tally.
                          papeletas que debe      
                          procesar.               

  SE-06                   Implementar las reglas  Lógica de conteo.
                          de conteo y las         
                          validaciones            
                          necesarias.             

  SE-07                   Coordinar con Andres la Integración entre
                          publicación de votos y  componentes.
                          con Sergio la entrega   
                          de información para     
                          Analytics.              

  SE-08                   Configurar reintentos,  Procesamiento robusto
                          confirmaciones de       de mensajes.
                          mensajes y manejo de    
                          errores.                

  SE-09                   Implementar pruebas de  Pruebas de mensajería y
                          publicación, consumo y  conteo.
                          procesamiento de votos. 
  -----------------------------------------------------------------------

**Criterio de aceptación:** RabbitMQ permite distribuir eventos entre
los componentes y Tally procesa los votos sin contabilizar repetidamente
los mismos registros por causa de reintentos.

**Decisión arquitectónica que debe documentarse:** el diagrama muestra
una relación entre Tally y Ballot, además de su comunicación con
RabbitMQ. Deben especificar qué información circula por cada conexión y
cuál es la fuente de verdad para el conteo.

### 3.7. Camilo --- Notifications y MongoDB

**Objetivo:** implementar las notificaciones generadas a partir de los
eventos del sistema.

  -----------------------------------------------------------------------
  ID                      Actividad               Entregable
  ----------------------- ----------------------- -----------------------
  CA-01                   Definir los eventos que Catálogo de eventos
                          deben generar           notificables.
                          notificaciones.         

  CA-02                   Implementar el servicio Servicio de
                          Notifications en        notificaciones.
                          TypeScript.             

  CA-03                   Configurar MongoDB para Colección de
                          almacenar los registros notificaciones.
                          de notificaciones.      

  CA-04                   Implementar el          Consumidor de mensajes.
                          consumidor de eventos   
                          de RabbitMQ.            

  CA-05                   Implementar la lógica   Flujo de notificación
                          para generar y          funcional.
                          registrar               
                          notificaciones.         

  CA-06                   Definir el contenido de Plantillas y reglas de
                          las notificaciones y    seguridad.
                          evitar incluir datos    
                          sensibles innecesarios. 

  CA-07                   Implementar un endpoint API de consulta.
                          HTTP para consultar el  
                          historial de            
                          notificaciones, si      
                          corresponde al alcance  
                          funcional.              

  CA-08                   Probar el procesamiento Pruebas automatizadas.
                          de eventos repetidos y  
                          el registro de          
                          notificaciones.         

  CA-09                   Preparar el contenedor  Dockerfile y
                          del servicio y          documentación.
                          documentar su           
                          configuración.          
  -----------------------------------------------------------------------

**Criterio de aceptación:** los eventos definidos generan los registros
de notificación esperados, que quedan almacenados en MongoDB.

**Aclaración:** el diagrama contempla el servicio Notifications y su
base de datos, pero no especifica un proveedor externo de correo
electrónico, SMS o notificaciones push. Esas integraciones no deberían
considerarse obligatorias sin un acuerdo explícito del equipo.

### 3.8. Sergio --- Analytics y Results en Rust

**Objetivo:** implementar el componente analítico encargado de procesar
información de los votos y generar los resultados de las elecciones.

  -----------------------------------------------------------------------
  ID                      Actividad               Entregable
  ----------------------- ----------------------- -----------------------
  SR-01                   Definir las métricas y  Especificación de
                          los resultados que se   resultados.
                          deben producir.         

  SR-02                   Diseñar la estructura   Modelo de persistencia.
                          de los documentos de    
                          Results en MongoDB.     

  SR-03                   Implementar el servicio Servicio ejecutable.
                          Analytics en Rust.      

  SR-04                   Implementar el          Consumidor integrado
                          consumidor de los       con RabbitMQ.
                          eventos de votos que    
                          correspondan.           

  SR-05                   Desarrollar la lógica   Algoritmo de cálculo de
                          de agregación de los    resultados.
                          votos.                  

  SR-06                   Implementar la          Operaciones de
                          persistencia de         almacenamiento y
                          resultados en MongoDB.  consulta.

  SR-07                   Definir un endpoint     API de consulta de
                          HTTP para consultar los resultados.
                          resultados.             

  SR-08                   Implementar pruebas con Pruebas de exactitud
                          conjuntos de votos      del conteo.
                          conocidos.              

  SR-09                   Verificar el            Pruebas de
                          tratamiento de mensajes consistencia.
                          repetidos y de          
                          resultados parciales.   

  SR-10                   Preparar el contenedor  Dockerfile y
                          de Analytics y          documentación.
                          documentar su           
                          configuración.          
  -----------------------------------------------------------------------

**Criterio de aceptación:** Analytics procesa la información acordada,
calcula los resultados correctamente y los persiste en MongoDB.

**Dependencia crítica:** Sergio debe coordinar con Sebastian y Andres el
formato de los datos de entrada. Además, debe acordar con Cristhian la
respuesta HTTP que consumirá el frontend.

## 4. Responsabilidades compartidas de integración

  -----------------------------------------------------------------------
  Actividad         Responsable       Colaboradores     Fecha objetivo
  transversal       principal                           
  ----------------- ----------------- ----------------- -----------------
  Definición de     Cristhian         Todos los         28 de octubre
  contratos HTTP                      responsables de   
                                      servicios         

  Definición de     Sebastian         Fabian, Kevin,    28 de octubre
  contratos de                        Andres, Camilo y  
  eventos                             Sergio            

  Configuración de  Sebastian         Fabian, Kevin,    29 de octubre
  RabbitMQ                            Andres, Camilo y  
                                      Sergio            

  Configuración de  Responsable de    Integrante        29 de octubre
  bases de datos    cada servicio     responsable del   
                                      despliegue        

  Dockerfile de     Cada integrante   ---               30 de octubre
  cada componente                                       

  Integración de    Cristhian         Julian y Andres   30 de octubre
  clientes con el                                       
  Gateway                                               

  Integración de    Sebastian         Andres y Sergio   31 de octubre
  votos, Tally y                                        
  Analytics                                             

  Integración de    Sebastian         Kevin y Fabian    31 de octubre
  eventos de                                            
  identidad y                                           
  elecciones                                            

  Integración de    Camilo            Sebastian         31 de octubre
  Notifications                                         

  Pruebas de        Todo el equipo    Coordinación de   1 de noviembre
  extremo a extremo                   Cristhian         

  Vista C&C y       Cristhian         Todo el equipo    1 de noviembre
  patrones                                              

  Vista de          Sebastian         Todo el equipo    1 de noviembre
  despliegue                                            

  Vista por capas   Julian            Cristhian y Kevin 1 de noviembre

  Vista de          Fabian            Responsables de   1 de noviembre
  descomposición                      los servicios     

  Consolidación del Todo el equipo    Un integrante     2 de noviembre
  PDF y las                           designado para    
  instrucciones de                    consolidar la     
  ejecución                           entrega           
  -----------------------------------------------------------------------

Las fechas corresponden al cronograma propuesto para llegar a la entrega
del 2 de noviembre de 2026.

## 5. Dependencias entre integrantes

  -----------------------------------------------------------------------
  Integrante              Debe coordinarse con    Motivo
  ----------------------- ----------------------- -----------------------
  Cristhian               Julian                  Compatibilidad del JWT
                                                  entre Auth y API
                                                  Gateway.

  Cristhian               Fabian, Kevin, Andres,  Definición de rutas y
                          Sebastian, Camilo y     contratos HTTP.
                          Sergio                  

  Julian                  Cristhian               Autenticación y
                                                  validación de tokens.

  Fabian                  Sebastian               Publicación de eventos
                                                  de elecciones.

  Kevin                   Sebastian               Publicación y consumo
                                                  de eventos de
                                                  identidad.

  Kevin                   Andres                  Flujo de firma ciega y
                                                  envío de papeletas.

  Andres                  Sebastian               Publicación y
                                                  procesamiento de
                                                  eventos de votos.

  Sebastian               Sergio                  Contrato de eventos y
                                                  datos que consume
                                                  Analytics.

  Sebastian               Camilo                  Configuración de colas
                                                  y eventos de
                                                  notificaciones.

  Sergio                  Cristhian               Contrato de consulta de
                                                  resultados para el
                                                  frontend.

  Todos                   Responsable de          Integración de las
                          consolidación           cuatro vistas y
                          documental              preparación de la
                                                  entrega.
  -----------------------------------------------------------------------

## 6. Criterios comunes para dar por terminado un componente

Cada integrante debe entregar su componente con estos elementos mínimos:

1.  **Código funcional** en la tecnología asignada.
2.  **Contrato de comunicación** documentado.
3.  **Persistencia o integración externa** operativa, cuando
    corresponda.
4.  **Pruebas básicas** que demuestren su funcionamiento.
5.  **Dockerfile** y configuración de variables de entorno, cuando el
    componente se ejecute en contenedor.
6.  **README breve** con las instrucciones para instalar, configurar y
    ejecutar el componente.
7.  **Pull request** con los cambios y la descripción de las pruebas
    realizadas.

## 7. Cronograma de implementación

  --------------------------------------------------------------------------
  Fecha             Fase              Actividades        Resultado esperado
                                      principales        
  ----------------- ----------------- ------------------ -------------------
  27 de octubre     Análisis y        Revisar el         Inventario de
                    acuerdos          prototipo 1,       funcionalidades,
                                      definir el         responsabilidades y
                                      alcance, validar   contratos
                                      la arquitectura y  iniciales.
                                      repartir tareas.   

  28 de octubre     Diseño detallado  Definir endpoints, Contratos de
                                      esquemas de datos, integración
                                      eventos y          acordados.
                                      estructura de los  
                                      proyectos.         

  29 de octubre     Desarrollo de     Implementar las    Primera versión
                    componentes       funcionalidades    ejecutable de cada
                                      principales de los componente.
                                      ocho componentes   
                                      lógicos.           

  30 de octubre     Persistencia e    Integrar bases de  Flujos parciales
                    interfaces        datos, clientes y  funcionales.
                                      servicios HTTP.    

  31 de octubre     Integración y     Integrar           Primera versión
                    despliegue        servicios,         integrada del
                                      configurar         prototipo.
                                      mensajería y       
                                      Docker Compose.    

  1 de noviembre    Pruebas y         Corregir errores,  Versión candidata
                    documentación     ejecutar pruebas   para entrega.
                                      de extremo a       
                                      extremo y          
                                      completar las      
                                      vistas             
                                      arquitectónicas.   

  2 de noviembre    Entrega           Verificar el PDF,  Entrega del
                                      probar las         prototipo 2.
                                      instrucciones y    
                                      entregar el        
                                      artefacto en       
                                      MiCampus UNAL.     

  3 de noviembre    Presentación      Demostrar el       Presentación del
                                      funcionamiento y   proyecto.
                                      explicar las       
                                      decisiones         
                                      arquitectónicas.   
  --------------------------------------------------------------------------

### Reglas para cumplir el cronograma

1.  **No esperar a que termine el backend para empezar el frontend.**
    Los contratos HTTP deben estar definidos el 28 de octubre. A partir
    de ellos, los clientes pueden avanzar con respuestas simuladas
    mientras los servicios se implementan.
2.  **No dejar Docker para el último día.** Desde el 29 de octubre, cada
    componente debe poder construirse y ejecutarse en su propio
    contenedor. La integración se realiza progresivamente.
3.  **Congelar las funcionalidades antes de ampliar el alcance.** Es
    preferible entregar un flujo de votación pequeño pero funcional,
    acompañado de una arquitectura bien documentada, que intentar
    implementar muchas funcionalidades sin integrar los componentes.

## 8. Organización sugerida del repositorio

``` text
Votaciones/
├── clients/
│   ├── cli-java/
│   ├── web-nextjs/
│   └── mobile-flutter/
│
├── services/
│   ├── api-gateway/
│   ├── auth-python/
│   ├── election-python/
│   ├── identity-python/
│   ├── blind-signature-python/
│   ├── ballot-go/
│   ├── tally-go/
│   ├── analytics-rust/
│   └── notifications-typescript/
│
├── infrastructure/
│   ├── docker-compose.yml
│   ├── postgres/
│   ├── mongodb/
│   └── rabbitmq/
│
├── contracts/
│   ├── openapi/
│   └── events/
│
├── docs/
│   ├── c-and-c.md
│   ├── deployment.md
│   ├── layered.md
│   ├── decomposition.md
│   └── sequences.md
│
├── tests/
│   ├── integration/
│   └── end-to-end/
│
└── README.md
```

Esta estructura es una sugerencia y puede adaptarse a la organización
existente del repositorio.

### Flujo de trabajo con GitHub

1.  Crear una rama por componente o tarea.
2.  Acordar convenciones de nombres, formato y pruebas.
3.  Desarrollar de manera independiente.
4.  Abrir pull requests pequeños.
5.  Revisar que los cambios no rompan los contratos de integración.
6.  Integrar periódicamente en la rama principal.
7.  Ejecutar las pruebas y la construcción de los componentes afectados.

Cada pull request debe incluir una descripción del cambio, las
instrucciones de ejecución y las pruebas realizadas.

## 9. Documentación de las estructuras arquitectónicas

La entrega no consiste únicamente en desarrollar el software. También
requiere documentar las estructuras arquitectónicas solicitadas para el
prototipo 2.

  --------------------------------------------------------------------------
  Artefacto         Responsable       Colaboradores     Contenido
                    principal                           
  ----------------- ----------------- ----------------- --------------------
  C&C: componentes  Cristhian         Personas          Componentes,
  y conectores                        responsables de   interfaces,
                                      los servicios     conexiones HTTP y
                                                        eventos asíncronos,
                                                        estilos y patrones.

  Despliegue        Sebastian         Todo el equipo    Contenedores, redes,
                                                        bases de datos,
                                                        broker y relaciones
                                                        de despliegue.

  Estructura por    Julian            Cristhian y Kevin Capas de
  capas                                                 presentación,
                                                        lógica, acceso a
                                                        datos y sus
                                                        dependencias.

  Descomposición    Fabian            Responsables de   Descomposición de
                                      los servicios     los principales
                                                        componentes en
                                                        módulos y
                                                        responsabilidades.

  Descripción de    Cristhian         Todo el equipo    Justificación de los
  patrones                                              patrones y estilos
                                                        arquitectónicos
                                                        empleados.

  Documento final   Todo el equipo    Integrante        Integración de las
                                      designado para    vistas, descripción
                                      consolidar la     del sistema,
                                      entrega           instrucciones de
                                                        ejecución y
                                                        exportación a PDF.
  --------------------------------------------------------------------------

### Contenido de cada vista

-   **Vista C&C:** debe representar los componentes de la arquitectura,
    sus responsabilidades y los conectores que los unen. Debe
    diferenciar las llamadas HTTP de los mensajes asíncronos.
-   **Vista de despliegue:** debe mostrar dónde se ejecuta cada
    componente: contenedores, redes, bases de datos y broker de
    mensajería. No basta con repetir el diagrama lógico.
-   **Vista por capas:** debe explicar cómo se organizan las
    responsabilidades y qué dependencias existen entre presentación,
    lógica y datos. No es necesario forzar todos los servicios
    distribuidos a una única estructura física por capas.
-   **Vista de descomposición:** debe mostrar cómo se divide cada
    componente relevante en módulos internos. Por ejemplo, Ballot podría
    dividirse en API, validación, lógica de negocio, persistencia y
    publicación de eventos.

Cada vista debe acompañarse de una descripción de los elementos, las
relaciones y los patrones utilizados.

## 10. Riesgos y decisiones arquitectónicas pendientes

### 10.1. API Gateway como cuello de botella

El Gateway debe enrutar las peticiones y aplicar las políticas
transversales que correspondan, pero no debería absorber la lógica de
votación, identidad o análisis.

**Acción:** acordar qué responsabilidades pertenecen al Gateway y cuáles
a los servicios.

### 10.2. Mecanismo de mensajería

La vista C&C identifica RabbitMQ, pero deben especificarse los
exchanges, las colas, las routing keys y el protocolo de comunicación
entre productores y consumidores.

**Acción:** seleccionar y documentar la configuración de mensajería
antes de implementar las integraciones.

### 10.3. Conteo duplicado de votos

Los sistemas asíncronos pueden recibir mensajes repetidos, por lo que
Tally y Analytics deben manejar correctamente los reintentos.

**Acción:** definir un mecanismo de deduplicación y criterios claros de
aceptación de votos, de modo que un evento repetido no incremente dos
veces los resultados.

### 10.4. Seguridad criptográfica

La firma ciega y la separación entre identidad y voto son sensibles a
cambios en el flujo de información.

**Acción:** revisar las propiedades de seguridad del protocolo existente
y comprobar que los nuevos contratos no introduzcan asociaciones
indebidas entre votantes y papeletas.

### 10.5. Sobrecarga de trabajo en interfaces y despliegue

La distribución de interfaces, servicios y documentación puede generar
sobrecarga si se deja toda la integración para una sola persona.

**Acción:** reutilizar los clientes existentes y solicitar ayuda puntual
a los responsables de los servicios para las tareas de despliegue y
documentación.

### 10.6. Responsabilidad sobre Tally y Analytics

Tally y Analytics tienen responsabilidades cercanas, por lo que debe
quedar claro qué componente realiza el conteo oficial y cuál calcula
estadísticas o resultados derivados.

**Acción:** documentar la responsabilidad de cada componente, el formato
de los eventos y la fuente de verdad de los resultados.

## 11. Checklist final de aceptación

### Arquitectura

-   [ ] Existen al menos ocho componentes lógicos identificables.
-   [ ] Hay al menos dos componentes de presentación diferentes.
-   [ ] El frontend web implementa SSR.
-   [ ] El API Gateway conecta los clientes con los servicios
    correspondientes.
-   [ ] Existen al menos cuatro componentes de datos, incluyendo bases
    relacionales y NoSQL.
-   [ ] Hay un componente funcional para procesamiento asíncrono.
-   [ ] Los conectores HTTP están documentados.
-   [ ] Se utilizan al menos cinco lenguajes de propósito general.
-   [ ] La arquitectura se despliega mediante contenedores.

### Funcionamiento

-   [ ] Los servicios principales arrancan correctamente.
-   [ ] Las conexiones a las bases de datos funcionan.
-   [ ] La mensajería asíncrona está operativa.
-   [ ] Los clientes se comunican con el Gateway.
-   [ ] Se puede demostrar un flujo de votación de principio a fin.
-   [ ] Los resultados corresponden a los votos procesados.
-   [ ] Se han probado los errores principales.

### Documentación

-   [ ] Está documentada la estructura C&C.
-   [ ] Está documentada la estructura de despliegue.
-   [ ] Está documentada la estructura por capas.
-   [ ] Está documentada la estructura de descomposición.
-   [ ] Se describen los elementos, relaciones, estilos y patrones.
-   [ ] El README contiene las instrucciones para ejecutar el sistema.
-   [ ] El documento se encuentra en Markdown y ha sido exportado a PDF.
-   [ ] El PDF tiene el nombre `p2_X.pdf`.
-   [ ] Se ha comprobado que el archivo está listo para su entrega en
    MiCampus UNAL.

## 12. Recomendación final

La asignación queda organizada en ocho responsables, con Sergio dedicado
a Rust y Analytics. El mayor riesgo está en la integración de los
servicios y en la definición del flujo de votos entre Ballot, RabbitMQ,
Tally y Analytics.

El equipo debería priorizar tres hitos:

-   **28 de octubre:** contratos HTTP y eventos acordados.
-   **31 de octubre:** servicios integrados y ejecutándose mediante
    contenedores.
-   **1 de noviembre:** flujo de votación probado y documentación
    arquitectónica consolidada.

Así, el último día se reserva para verificar y entregar el artefacto, en
lugar de intentar resolver problemas estructurales de integración a
última hora.

La condición de éxito es que todos los integrantes trabajen con
contratos compartidos, una misma definición del alcance funcional y una
estrategia de integración continua. Ningún componente debería
considerarse terminado hasta que esté integrado, probado y documentado.
