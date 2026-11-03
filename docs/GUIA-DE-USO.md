# Guia de uso

Há três jeitos de entrar numa live. Todos falam com o mesmo relay, e a sala é sempre a do
**canal de voz** em que você está.

| Onde | Assistir | Transmitir | Salas de voz |
|---|---|---|---|
| Activity do Discord | Sim | Abre uma aba do navegador (`present.html`) | Não |
| Aba do navegador (`watch.html`) | Sim, com tela cheia de verdade | Não | Não |
| App Janja (Windows) | Sim | Sim, com simulcast e áudio por app | Sim |

Na primeira vez em cada dispositivo aparece uma enquete de abertura; a resposta só decide se
o app abre e não é enviada a lugar nenhum (veja `client/src/ui/votePoll.ts`).

## Assistir

**Pela Activity:** entre num canal de voz, abra a Activity e escolha uma live na lista. A
Activity mostra todas as lives do seu canal.

**Pelo navegador:** dentro da Activity, use **Assistir numa aba do navegador**. A aba abre
na mesma sala e permite tela cheia real (a Activity só tem uma tela cheia simulada). Enquanto
a aba estiver aberta, a Activity pausa para a mesma live não chegar duas vezes; **Retomar
aqui** volta a receber na Activity.

**Pelo Janja:** faça login com o Discord. O app acompanha o seu canal de voz (consulta a cada
poucos segundos e quando a janela ganha foco) e mostra, na barra lateral, o seu canal e os
canais com alguém ao vivo. O app nunca toca a sua própria live, para não gastar a sua banda;
clicar nela abre uma prévia de propósito.

Controles do player:

- **Qualidade**: em lives do Janja, escolha a versão (por exemplo 1080p60, 720p30, 480p30)
  ou **Automático**, que desce quando sua conexão não acompanha e sobe depois de 15 s estável.
- **Somente áudio**: para de receber o vídeo e continua com o som. Bom para ouvir música.
- **Sair da live / Voltar a assistir** (Janja): para de receber sem sair do canal.
- **Espectadores**: quem está na sala e o que cada um assiste.
- **Estatísticas** (`Ctrl+Shift+S`): atraso, fila do decodificador, folga do áudio, falhas,
  quadros por segundo e a camada recebida.

## Transmitir

### Pelo Janja (recomendado)

1. Clique em **Transmitir**.
2. Escolha uma tela ou janela.
3. Escolha resolução (480p, 720p, 1080p), quadros (30 ou 60) e nível (Equilibrada, Alta,
   Máxima). Os níveis multiplicam o bitrate por 1x, 1,5x e 2x; 1080p60 Equilibrada usa
   6 Mbps. Jogos com muita partícula pedem Alta ou Máxima.
4. Em **Áudio da live**, desmarque os apps que não devem ir para a live (o Discord já vem de
   fora). Sem o helper de áudio, o app cai para o som do sistema inteiro. Também dá para
   transmitir sem som.
5. **Qualidade do som**: Leve (64 kbps, para PC fraco ou upload ruim), Normal (96 kbps) ou
   Alta (160 kbps, padrão).

O Janja envia a qualidade escolhida mais 720p30 e 480p30 por baixo (só as que forem menores).
Uma camada que ninguém assiste é pausada. Se ninguém assiste, nada é enviado; o painel do
usuário mostra quantas pessoas estão assistindo.

Se o seu upload engasga (o ping do jogo sobe), o app mede a fila do roteador e baixa o
bitrate sozinho. Se você sair do canal de voz no Discord com a live aberta, o app pergunta
se deve encerrá-la. A bandeja do Windows tem **Encerrar transmissão**.

### Pelo navegador

Na Activity, clique em **Compartilhar tela**. Uma aba `present.html` abre no navegador (o
Discord bloqueia a captura de tela dentro da Activity). Escolha resolução, quadros e
qualidade, e compartilhe a tela ou aba. O áudio é o que o Chrome oferecer (aba ou sistema).
Essa forma envia uma única versão, sem simulcast.

## Salas de voz (Janja)

Na seção **Salas de voz** da barra lateral qualquer pessoa logada pode criar uma sala e
entrar nas existentes. A sala some quando a última pessoa sai. Limites: 30 salas, 12 pessoas
por sala, nome de até 40 caracteres.

- Microfone e fone no canto inferior esquerdo, como no Discord. As setas abrem o dispositivo,
  o volume (0 a 200%), a barra de sensibilidade, o RNNoise (supressão de ruído local) e o
  teste de microfone.
- Clique numa pessoa para ajustar o volume dela só para você (0 a 200%).
- As salas vêm desligadas: um admin precisa ligá-las.

## Recursos de admin

Admins são os IDs em `ADMIN_USER_IDS` (veja [CONFIGURACAO.md](CONFIGURACAO.md)). O servidor
confere o admin em cada pedido; a interface só decide o que mostrar.

- **Encerrar esta transmissão** de qualquer pessoa (os outros só encerram a própria).
- **Bater na porta**: toca uma batida na máquina de quem transmite (e notifica o Windows se a
  janela estiver escondida), para chamar alguém de fone no jogo.
- **Ganho para todos**: aumenta o som de uma live para todos, até 1000%, com limitador.
- **Assistir oculto**: fora da lista de espectadores e de todas as contagens.
- **Lista de lives**: a de um admin mostra as lives de todas as salas e servidores do relay.
- **Captura do apresentador** nas estatísticas: quais apps o helper de áudio está pegando e
  em que estado (ok, mudo, silencioso, falhou...).
- Salas de voz: ligar/desligar para todos e fechar qualquer sala.
